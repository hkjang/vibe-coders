package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// ModelContract is a per-task-type minimum-quality SLA a model must meet before it can be
// adopted (model swap, auto-routing target, MCP agentic model). A threshold of 0 means
// "not enforced" for that dimension.
type ModelContract struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	TaskType          string  `json:"task_type"`
	MinQualityScore   float64 `json:"min_quality_score"`    // 0..100
	MinGoldenPassRate float64 `json:"min_golden_pass_rate"` // 0..1
	MinSuccessRate    float64 `json:"min_success_rate"`     // 0..1
	MaxLatencyMS      int64   `json:"max_latency_ms"`
	MaxAvgCostKRW     float64 `json:"max_avg_cost_krw"`
	Enabled           bool    `json:"enabled"`
	CreatedBy         string  `json:"created_by"`
	CreatedAt         string  `json:"created_at"`
	UpdatedAt         string  `json:"updated_at"`
}

func (s *SQLStore) UpsertModelContract(ctx context.Context, c ModelContract) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if c.CreatedAt == "" {
		c.CreatedAt = now
	}
	enabled := 0
	if c.Enabled {
		enabled = 1
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO model_contracts
		(id, name, task_type, min_quality_score, min_golden_pass_rate, min_success_rate, max_latency_ms, max_avg_cost_krw, enabled, created_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name=excluded.name, task_type=excluded.task_type, min_quality_score=excluded.min_quality_score,
			min_golden_pass_rate=excluded.min_golden_pass_rate, min_success_rate=excluded.min_success_rate,
			max_latency_ms=excluded.max_latency_ms, max_avg_cost_krw=excluded.max_avg_cost_krw,
			enabled=excluded.enabled, updated_at=excluded.updated_at`),
		c.ID, c.Name, c.TaskType, c.MinQualityScore, c.MinGoldenPassRate, c.MinSuccessRate, c.MaxLatencyMS, c.MaxAvgCostKRW, enabled, c.CreatedBy, c.CreatedAt, now)
	return err
}

func scanModelContract(sc interface{ Scan(...any) error }) (ModelContract, error) {
	var c ModelContract
	var enabled int
	if err := sc.Scan(&c.ID, &c.Name, &c.TaskType, &c.MinQualityScore, &c.MinGoldenPassRate, &c.MinSuccessRate,
		&c.MaxLatencyMS, &c.MaxAvgCostKRW, &enabled, &c.CreatedBy, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return ModelContract{}, err
	}
	c.Enabled = enabled != 0
	return c, nil
}

const modelContractColumns = `id, name, task_type, min_quality_score, min_golden_pass_rate, min_success_rate, max_latency_ms, max_avg_cost_krw, enabled, created_by, created_at, updated_at`

func (s *SQLStore) ListModelContracts(ctx context.Context, onlyEnabled bool) ([]ModelContract, error) {
	q := `SELECT ` + modelContractColumns + ` FROM model_contracts`
	if onlyEnabled {
		q += ` WHERE enabled = 1`
	}
	q += ` ORDER BY task_type ASC, name ASC`
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ModelContract{}
	for rows.Next() {
		c, err := scanModelContract(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetModelContract(ctx context.Context, id string) (ModelContract, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT `+modelContractColumns+` FROM model_contracts WHERE id = ?`), id)
	c, err := scanModelContract(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ModelContract{}, false, nil
	}
	if err != nil {
		return ModelContract{}, false, err
	}
	return c, true, nil
}

func (s *SQLStore) DeleteModelContract(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM model_contracts WHERE id = ?`), id)
	return err
}

// ModelAvgCost returns the average estimated cost (KRW) per request, per model, since `since`.
func (s *SQLStore) ModelAvgCost(ctx context.Context, since time.Time) (map[string]float64, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT r.model, AVG(COALESCE(t.estimated_cost, 0))
		FROM request_logs r
		JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ? AND COALESCE(NULLIF(r.model, ''), '') <> ''
		GROUP BY r.model`), since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]float64{}
	for rows.Next() {
		var model string
		var avg float64
		if err := rows.Scan(&model, &avg); err != nil {
			return nil, err
		}
		out[model] = avg
	}
	return out, rows.Err()
}

// FailedGoldenForModel returns the model's failed golden-prompt results since `since` (newest
// first). Used to surface failing-sample fingerprints — callers must not expose raw responses.
func (s *SQLStore) FailedGoldenForModel(ctx context.Context, model string, since time.Time, limit int) ([]GoldenPromptResult, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT id, prompt_id, model, score, passed, cost_krw, latency_ms, created_at
		FROM golden_prompt_results
		WHERE model = ? AND passed = 0 AND created_at >= ?
		ORDER BY created_at DESC LIMIT ?`), model, since.UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GoldenPromptResult{}
	for rows.Next() {
		var g GoldenPromptResult
		var passed int
		var createdAt string
		if err := rows.Scan(&g.ID, &g.PromptID, &g.Model, &g.Score, &passed, &g.CostKRW, &g.LatencyMS, &createdAt); err != nil {
			return nil, err
		}
		g.Passed = passed != 0
		if ts, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			g.CreatedAt = ts
		}
		out = append(out, g)
	}
	return out, rows.Err()
}
