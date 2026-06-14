package store

import (
	"context"
	"time"

	"vibe-coders/internal/config"
)

// ModelPricingVersion is one historical price entry for a model. The newest row
// per model (by created_at) is the effective price; older rows are kept as history.
type ModelPricingVersion struct {
	ID                  string  `json:"id"`
	Model               string  `json:"model"`
	InputKRWPer1M       float64 `json:"input_krw_per_1m"`
	OutputKRWPer1M      float64 `json:"output_krw_per_1m"`
	CachedInputKRWPer1M float64 `json:"cached_input_krw_per_1m"`
	Source              string  `json:"source"`
	Note                string  `json:"note"`
	CreatedAt           string  `json:"created_at"`
}

// InsertPricingVersion appends a new price version for a model.
func (s *SQLStore) InsertPricingVersion(ctx context.Context, v ModelPricingVersion) error {
	if v.CreatedAt == "" {
		v.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO model_pricing_versions
		(id, model, input_krw_per_1m, output_krw_per_1m, cached_input_krw_per_1m, source, note, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
		v.ID, v.Model, v.InputKRWPer1M, v.OutputKRWPer1M, v.CachedInputKRWPer1M, v.Source, v.Note, v.CreatedAt)
	return err
}

// ListPricingVersions returns price versions for a model (or all when model==""),
// newest first.
func (s *SQLStore) ListPricingVersions(ctx context.Context, model string, limit int) ([]ModelPricingVersion, error) {
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	q := `SELECT id, model, input_krw_per_1m, output_krw_per_1m, cached_input_krw_per_1m, COALESCE(source, ''), COALESCE(note, ''), created_at
		FROM model_pricing_versions`
	args := []any{}
	if model != "" {
		q += ` WHERE model = ?`
		args = append(args, model)
	}
	q += ` ORDER BY model, created_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ModelPricingVersion{}
	for rows.Next() {
		var v ModelPricingVersion
		if err := rows.Scan(&v.ID, &v.Model, &v.InputKRWPer1M, &v.OutputKRWPer1M, &v.CachedInputKRWPer1M, &v.Source, &v.Note, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// LatestPricing returns the newest price version per model as a config.ModelPrice
// map, suitable for merging over the env-configured pricing.
func (s *SQLStore) LatestPricing(ctx context.Context) (map[string]config.ModelPrice, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT model, input_krw_per_1m, output_krw_per_1m, cached_input_krw_per_1m, created_at
		FROM model_pricing_versions ORDER BY model, created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]config.ModelPrice{}
	for rows.Next() {
		var model, createdAt string
		var in, outv, cached float64
		if err := rows.Scan(&model, &in, &outv, &cached, &createdAt); err != nil {
			return nil, err
		}
		if _, seen := out[model]; seen {
			continue // rows are newest-first per model; keep the first
		}
		out[model] = config.ModelPrice{InputKRWPer1M: in, OutputKRWPer1M: outv, CachedInputKRWPer1M: cached}
	}
	return out, rows.Err()
}
