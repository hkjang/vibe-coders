package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// PromptStageSnapshot retains revision material only on the server. Note and
// actor never belong in the workspace's browser projection.
type PromptStageSnapshot struct {
	Promotion  PromptPromotion
	Registered bool
}
type PromptStageWorkspaceRow struct {
	Snapshot PromptStageSnapshot
	Stats    PromptVersionStat
}

func (s *SQLStore) GetPromptStageSnapshot(ctx context.Context, name, version string) (PromptStageSnapshot, error) {
	out := PromptStageSnapshot{Promotion: PromptPromotion{PromptName: name, PromptVersion: version, Stage: PromptStageExperiment}}
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT stage, COALESCE(note, ''), COALESCE(promoted_by, ''), updated_at FROM prompt_promotions WHERE prompt_name = ? AND prompt_version = ?`), name, version).Scan(&out.Promotion.Stage, &out.Promotion.Note, &out.Promotion.PromotedBy, &out.Promotion.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return PromptStageSnapshot{}, err
	}
	out.Registered = true
	return out, nil
}

// PromptStageWorkspacePage includes saved stages even without calls in the
// selected interval. Total, page, stages and observations share one read snapshot.
func (s *SQLStore) PromptStageWorkspacePage(ctx context.Context, since, until time.Time, stage string, limit, offset int) ([]PromptStageWorkspaceRow, int, error) {
	if limit < 1 || limit > 100 || offset < 0 || offset > 1000000 || !since.Before(until) || (stage != "all" && !validPromptStage(stage)) {
		return nil, 0, fmt.Errorf("invalid stage page")
	}
	where, args := metadataTimestampWindowSQL("r.created_at", since, until)
	keys := `WITH observed_keys AS (SELECT DISTINCT r.prompt_name, r.prompt_version FROM request_logs r WHERE ` + where + ` AND COALESCE(r.prompt_name, '') <> '' AND COALESCE(r.prompt_version, '') <> ''),
 keys AS (SELECT prompt_name, prompt_version FROM prompt_promotions UNION SELECT prompt_name, prompt_version FROM observed_keys),
 filtered AS (SELECT k.prompt_name, k.prompt_version FROM keys k LEFT JOIN prompt_promotions p ON p.prompt_name=k.prompt_name AND p.prompt_version=k.prompt_version WHERE (? = 'all' OR COALESCE(p.stage, 'experiment') = ?))`
	args = append(args, stage, stage)
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable, ReadOnly: true})
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback()
	var total int
	if err := tx.QueryRowContext(ctx, s.bind(keys+` SELECT COUNT(*) FROM filtered`), args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	selected := keys + `, selected AS (SELECT * FROM filtered ORDER BY prompt_name, prompt_version LIMIT ? OFFSET ?),
 stats(prompt_name, prompt_version, calls, errors, failures, cost) AS (` + promptVersionStatsSQL(where+` AND EXISTS (SELECT 1 FROM selected k WHERE k.prompt_name=r.prompt_name AND k.prompt_version=r.prompt_version)`) + `)`
	_, windowArgs := metadataTimestampWindowSQL("r.created_at", since, until)
	pageArgs := append(append(append([]any{}, args...), limit, offset), windowArgs...)
	rows, err := tx.QueryContext(ctx, s.bind(selected+` SELECT k.prompt_name, k.prompt_version, p.prompt_name IS NOT NULL,
 COALESCE(p.stage, 'experiment'), COALESCE(p.note, ''), COALESCE(p.promoted_by, ''), COALESCE(p.updated_at, ''),
 COALESCE(st.calls, 0), COALESCE(st.errors, 0), COALESCE(st.failures, 0)
 FROM selected k LEFT JOIN prompt_promotions p ON p.prompt_name=k.prompt_name AND p.prompt_version=k.prompt_version
 LEFT JOIN stats st ON st.prompt_name=k.prompt_name AND st.prompt_version=k.prompt_version ORDER BY k.prompt_name,k.prompt_version`), pageArgs...)
	if err != nil {
		return nil, 0, err
	}
	out := []PromptStageWorkspaceRow{}
	for rows.Next() {
		var item PromptStageWorkspaceRow
		p := &item.Snapshot.Promotion
		st := &item.Stats
		if err := rows.Scan(&p.PromptName, &p.PromptVersion, &item.Snapshot.Registered, &p.Stage, &p.Note, &p.PromotedBy, &p.UpdatedAt, &st.Calls, &st.Errors, &st.EvalFailures); err != nil {
			rows.Close()
			return nil, 0, err
		}
		st.PromptName, st.PromptVersion = p.PromptName, p.PromptVersion
		if st.Calls > 0 {
			st.ErrorRate = float64(st.Errors) / float64(st.Calls)
			st.EvalFailRate = float64(st.EvalFailures) / float64(st.Calls)
		}
		out = append(out, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, 0, err
	}
	if err = tx.Commit(); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

var ErrPromptStageConflict = errors.New("prompt stage changed")

func validPromptStage(stage string) bool {
	return stage == PromptStageExperiment || stage == PromptStageValidation || stage == PromptStageProduction
}

// CompareAndSetPromptStage commits the reviewed snapshot and audit atomically.
// A legacy writer also conflicts through the row predicate / unique constraint.
// No automatic retry is safe after a lost acknowledgement.
func (s *SQLStore) CompareAndSetPromptStage(ctx context.Context, expected PromptStageSnapshot, stage, reason string, audit AdminAuditLog) (PromptPromotion, error) {
	if !validPromptStage(stage) || expected.Promotion.PromptName == "" || expected.Promotion.PromptVersion == "" || reason == "" || audit.Action != "prompt.promotion.set" {
		return PromptPromotion{}, fmt.Errorf("invalid stage change")
	}
	p := expected.Promotion
	next := PromptPromotion{PromptName: p.PromptName, PromptVersion: p.PromptVersion, Stage: stage, Note: reason, PromotedBy: audit.AdminID, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	err := s.withAdminAuditTransaction(ctx, audit, func(tx *sql.Tx) error {
		var result sql.Result
		var err error
		if expected.Registered {
			result, err = tx.ExecContext(ctx, s.bind(`UPDATE prompt_promotions SET stage=?, note=?, promoted_by=?, updated_at=? WHERE prompt_name=? AND prompt_version=? AND stage=? AND COALESCE(note,'')=? AND COALESCE(promoted_by,'')=? AND updated_at=?`), next.Stage, next.Note, next.PromotedBy, next.UpdatedAt, p.PromptName, p.PromptVersion, p.Stage, p.Note, p.PromotedBy, p.UpdatedAt)
		} else {
			result, err = tx.ExecContext(ctx, s.bind(`INSERT INTO prompt_promotions(prompt_name,prompt_version,stage,note,promoted_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(prompt_name,prompt_version) DO NOTHING`), next.PromptName, next.PromptVersion, next.Stage, next.Note, next.PromotedBy, next.UpdatedAt)
		}
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrPromptStageConflict
		}
		return nil
	})
	if err != nil {
		return PromptPromotion{}, err
	}
	return next, nil
}
