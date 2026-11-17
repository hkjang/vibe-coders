package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// A larger observed set needs a narrower interval, never a partial application.
const MaxPromptStageBulkVersions = 1000

var ErrPromptStageBulkLimit = errors.New("too many observed prompt versions for synchronous review")

type promptStageQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// PromptStageBulkSnapshot reads observations and registered stages in one SQL
// statement snapshot. The existing per-request aggregation is shared with Legacy.
func (s *SQLStore) PromptStageBulkSnapshot(ctx context.Context, since, until time.Time) ([]PromptStageWorkspaceRow, error) {
	return s.promptStageBulkSnapshot(ctx, s.db, since, until)
}

func (s *SQLStore) promptStageBulkSnapshot(ctx context.Context, db promptStageQueryer, since, until time.Time) ([]PromptStageWorkspaceRow, error) {
	if !since.Before(until) {
		return nil, fmt.Errorf("invalid prompt observation interval")
	}
	where, args := metadataTimestampWindowSQL("r.created_at", since, until)
	query := `WITH stats(prompt_name,prompt_version,calls,errors,failures,cost) AS (` + promptVersionStatsSQL(where) + `)
 SELECT st.prompt_name,st.prompt_version,p.prompt_name IS NOT NULL,
 COALESCE(p.stage,'experiment'),COALESCE(p.note,''),COALESCE(p.promoted_by,''),COALESCE(p.updated_at,''),
 st.calls,st.errors,st.failures
 FROM stats st LEFT JOIN prompt_promotions p ON p.prompt_name=st.prompt_name AND p.prompt_version=st.prompt_version
 ORDER BY st.prompt_name,st.prompt_version LIMIT ?`
	rows, err := db.QueryContext(ctx, s.bind(query), append(args, MaxPromptStageBulkVersions+1)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptStageWorkspaceRow{}
	for rows.Next() {
		var item PromptStageWorkspaceRow
		p, st := &item.Snapshot.Promotion, &item.Stats
		if err := rows.Scan(&p.PromptName, &p.PromptVersion, &item.Snapshot.Registered, &p.Stage, &p.Note, &p.PromotedBy, &p.UpdatedAt, &st.Calls, &st.Errors, &st.EvalFailures); err != nil {
			return nil, err
		}
		st.PromptName, st.PromptVersion = p.PromptName, p.PromptVersion
		if st.Calls > 0 {
			st.ErrorRate = float64(st.Errors) / float64(st.Calls)
			st.EvalFailRate = float64(st.EvalFailures) / float64(st.Calls)
		}
		out = append(out, item)
		if len(out) > MaxPromptStageBulkVersions {
			return nil, ErrPromptStageBulkLimit
		}
	}
	return out, rows.Err()
}

type PromptStageBatchChange struct {
	Expected PromptStageSnapshot
	Stage    string
}

// ApplyPromptStageBulk re-reads the fixed interval, validates the caller's plan,
// then commits every conditional row change and one complete audit atomically.
// prepare is a pure review/criteria check; it must not perform external I/O.
func (s *SQLStore) ApplyPromptStageBulk(ctx context.Context, since, until time.Time, reason string, prepare func([]PromptStageWorkspaceRow) ([]PromptStageBatchChange, AdminAuditLog, error)) ([]PromptPromotion, error) {
	if reason == "" || prepare == nil {
		return nil, fmt.Errorf("invalid prompt stage batch")
	}
	changed := []PromptPromotion{}
	err := s.withPreparedAdminAuditTransaction(ctx, func(tx *sql.Tx) (AdminAuditLog, error) {
		rows, err := s.promptStageBulkSnapshot(ctx, tx, since, until)
		if err != nil {
			return AdminAuditLog{}, err
		}
		plan, audit, err := prepare(rows)
		if err != nil {
			return audit, err
		}
		if len(plan) == 0 || len(plan) > len(rows) || audit.Action != "prompt.promotion.auto" {
			return audit, fmt.Errorf("invalid prompt stage plan")
		}
		available := make(map[[2]string]PromptStageSnapshot, len(rows))
		for _, row := range rows {
			p := row.Snapshot.Promotion
			available[[2]string{p.PromptName, p.PromptVersion}] = row.Snapshot
		}
		stamp := time.Now().UTC().Format(time.RFC3339Nano)
		for _, change := range plan {
			p := change.Expected.Promotion
			key := [2]string{p.PromptName, p.PromptVersion}
			current, exists := available[key]
			if !exists || current != change.Expected || !validPromptStage(change.Stage) || change.Stage == p.Stage {
				return audit, ErrPromptStageConflict
			}
			delete(available, key)
			next := PromptPromotion{PromptName: p.PromptName, PromptVersion: p.PromptVersion, Stage: change.Stage, Note: reason, PromotedBy: audit.AdminID, UpdatedAt: stamp}
			if err := s.compareAndSetPromptStageTx(ctx, tx, change.Expected, next); err != nil {
				return audit, err
			}
			changed = append(changed, next)
		}
		return audit, nil
	})
	if err != nil {
		return nil, err
	}
	return changed, nil
}
