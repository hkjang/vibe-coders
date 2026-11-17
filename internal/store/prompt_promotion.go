package store

import (
	"context"
	"fmt"
	"time"
)

// PromptStage is the lifecycle stage of a prompt version.
const (
	PromptStageExperiment = "experiment"
	PromptStageValidation = "validation"
	PromptStageProduction = "production"
)

// PromptPromotion records the current lifecycle stage of one prompt version.
type PromptPromotion struct {
	PromptName    string `json:"prompt_name"`
	PromptVersion string `json:"prompt_version"`
	Stage         string `json:"stage"`
	Note          string `json:"note"`
	PromotedBy    string `json:"promoted_by"`
	UpdatedAt     string `json:"updated_at"`
}

// PromptVersionStat is the observed performance of one prompt version over a window.
type PromptVersionStat struct {
	PromptName    string  `json:"prompt_name"`
	PromptVersion string  `json:"prompt_version"`
	Calls         int64   `json:"calls"`
	Errors        int64   `json:"errors"`
	EvalFailures  int64   `json:"eval_failures"`
	ErrorRate     float64 `json:"error_rate"`
	EvalFailRate  float64 `json:"eval_fail_rate"`
	CostKRW       float64 `json:"cost_krw"`
}

func (s *SQLStore) ListPromptPromotions(ctx context.Context) ([]PromptPromotion, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT prompt_name, prompt_version, stage, COALESCE(note, ''), COALESCE(promoted_by, ''), updated_at
		FROM prompt_promotions ORDER BY prompt_name, prompt_version`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptPromotion{}
	for rows.Next() {
		var p PromptPromotion
		if err := rows.Scan(&p.PromptName, &p.PromptVersion, &p.Stage, &p.Note, &p.PromotedBy, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SetPromptStage upserts the lifecycle stage for a prompt version.
func (s *SQLStore) SetPromptStage(ctx context.Context, p PromptPromotion) error {
	if p.Stage == "" {
		p.Stage = PromptStageExperiment
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO prompt_promotions (prompt_name, prompt_version, stage, note, promoted_by, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(prompt_name, prompt_version) DO UPDATE SET stage = excluded.stage, note = excluded.note, promoted_by = excluded.promoted_by, updated_at = excluded.updated_at`),
		p.PromptName, p.PromptVersion, p.Stage, p.Note, p.PromotedBy, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

// PromptVersionStatsSince returns per-(name,version) performance over [since, now]
// for prompt versions that carry an explicit name+version.
func (s *SQLStore) PromptVersionStatsSince(ctx context.Context, since time.Time) ([]PromptVersionStat, error) {
	where, args := metadataTimestampWindowSQL("r.created_at", since, time.Now().UTC())
	rows, err := s.db.QueryContext(ctx, s.bind(promptVersionStatsSQL(where)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptVersionStat{}
	for rows.Next() {
		var v PromptVersionStat
		if err := rows.Scan(&v.PromptName, &v.PromptVersion, &v.Calls, &v.Errors, &v.EvalFailures, &v.CostKRW); err != nil {
			return nil, err
		}
		if v.Calls > 0 {
			v.ErrorRate = float64(v.Errors) / float64(v.Calls)
			v.EvalFailRate = float64(v.EvalFailures) / float64(v.Calls)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// Aggregate children within each request: several usage/evaluation records must
// not multiply the request count or each other's totals. Both console and legacy
// eligibility use this query. Evaluation failures count records, not requests.
func promptVersionStatsSQL(where string) string {
	return fmt.Sprintf(`SELECT r.prompt_name, r.prompt_version, COUNT(r.id),
 COALESCE(SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END), 0),
 COALESCE(SUM((SELECT SUM(CASE WHEN e.passed = 0 THEN 1 ELSE 0 END) FROM llm_evaluations e WHERE e.request_id = r.id)), 0),
 COALESCE(SUM((SELECT SUM(t.estimated_cost) FROM token_usage t WHERE t.request_id = r.id)), 0)
 FROM request_logs r WHERE %s AND COALESCE(r.prompt_name, '') <> '' AND COALESCE(r.prompt_version, '') <> ''
 GROUP BY r.prompt_name, r.prompt_version`, where)
}
