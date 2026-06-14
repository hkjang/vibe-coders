package store

import (
	"context"
	"time"
)

// CategoryScore is the pass rate for one evaluation category (e.g. compile, tests,
// security, review) for a model.
type CategoryScore struct {
	PassRate float64 `json:"pass_rate"`
	Samples  int64   `json:"samples"`
}

// ModelQualityScore is a composite coding-quality view of one model that goes
// beyond raw success rate: it blends request success, golden-prompt regression
// pass rate, and submitted evaluation pass rates (overall + per category such as
// compile success, test pass, security, and code-review reflection).
type ModelQualityScore struct {
	Model          string                   `json:"model"`
	Requests       int64                    `json:"requests"`
	SuccessRate    float64                  `json:"success_rate"`
	GoldenPassRate float64                  `json:"golden_pass_rate"`
	GoldenSamples  int64                    `json:"golden_samples"`
	EvalPassRate   float64                  `json:"eval_pass_rate"`
	EvalSamples    int64                    `json:"eval_samples"`
	Categories     map[string]CategoryScore `json:"categories"`
	QualityScore   float64                  `json:"quality_score"` // composite 0-100
}

// qualityCategories are the recognised coding-quality evaluation buckets that the
// composite score weights specifically (others still count toward EvalPassRate).
var qualityCategories = []string{"compile", "tests", "security", "review"}

// ModelQualityScores computes per-model composite quality over [since, now].
func (s *SQLStore) ModelQualityScores(ctx context.Context, since time.Time) ([]ModelQualityScore, error) {
	sinceStr := since.UTC().Format(time.RFC3339Nano)
	byModel := map[string]*ModelQualityScore{}
	get := func(model string) *ModelQualityScore {
		if model == "" {
			model = "unknown"
		}
		m, ok := byModel[model]
		if !ok {
			m = &ModelQualityScore{Model: model, Categories: map[string]CategoryScore{}}
			byModel[model] = m
		}
		return m
	}

	// 1) Request volume + success rate.
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(model, ''), 'unknown'),
			COUNT(*),
			SUM(CASE WHEN status_code BETWEEN 200 AND 299 AND COALESCE(error, '') = '' AND COALESCE(failover, 0) = 0 THEN 1 ELSE 0 END)
		FROM request_logs WHERE created_at >= ? GROUP BY COALESCE(NULLIF(model, ''), 'unknown')`), sinceStr)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var model string
		var total, ok int64
		if err := rows.Scan(&model, &total, &ok); err != nil {
			rows.Close()
			return nil, err
		}
		m := get(model)
		m.Requests = total
		if total > 0 {
			m.SuccessRate = float64(ok) / float64(total)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 2) Evaluation pass rates, overall and per category.
	evRows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(r.model, ''), 'unknown'), e.category,
			COUNT(*), SUM(CASE WHEN e.passed = 1 THEN 1 ELSE 0 END)
		FROM llm_evaluations e JOIN request_logs r ON r.id = e.request_id
		WHERE e.created_at >= ? GROUP BY COALESCE(NULLIF(r.model, ''), 'unknown'), e.category`), sinceStr)
	if err != nil {
		return nil, err
	}
	for evRows.Next() {
		var model, category string
		var total, passed int64
		if err := evRows.Scan(&model, &category, &total, &passed); err != nil {
			evRows.Close()
			return nil, err
		}
		m := get(model)
		m.EvalSamples += total
		m.EvalPassRate += float64(passed) // accumulate passes; divide below
		if category != "" && total > 0 {
			m.Categories[category] = CategoryScore{PassRate: float64(passed) / float64(total), Samples: total}
		}
	}
	evRows.Close()
	if err := evRows.Err(); err != nil {
		return nil, err
	}

	// 3) Golden prompt pass rates by model.
	gRows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(model, ''), 'unknown'),
			COUNT(*), SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END)
		FROM golden_prompt_results WHERE created_at >= ? GROUP BY COALESCE(NULLIF(model, ''), 'unknown')`), sinceStr)
	if err != nil {
		return nil, err
	}
	for gRows.Next() {
		var model string
		var total, passed int64
		if err := gRows.Scan(&model, &total, &passed); err != nil {
			gRows.Close()
			return nil, err
		}
		m := get(model)
		m.GoldenSamples = total
		if total > 0 {
			m.GoldenPassRate = float64(passed) / float64(total)
		}
	}
	gRows.Close()
	if err := gRows.Err(); err != nil {
		return nil, err
	}

	out := make([]ModelQualityScore, 0, len(byModel))
	for _, m := range byModel {
		if m.EvalSamples > 0 {
			m.EvalPassRate = m.EvalPassRate / float64(m.EvalSamples)
		}
		m.QualityScore = compositeQualityScore(m)
		out = append(out, *m)
	}
	return out, nil
}

// compositeQualityScore blends the available signals into a 0-100 score,
// normalising by the weights actually present so a model with no evals isn't
// unfairly penalised.
func compositeQualityScore(m *ModelQualityScore) float64 {
	type signal struct {
		value  float64
		weight float64
		has    bool
	}
	signals := []signal{
		{m.SuccessRate, 0.25, m.Requests > 0},
		{m.GoldenPassRate, 0.25, m.GoldenSamples > 0},
		{m.EvalPassRate, 0.25, m.EvalSamples > 0},
	}
	// Recognised coding-quality categories share the final quarter.
	var catSum, catN float64
	for _, c := range qualityCategories {
		if cs, ok := m.Categories[c]; ok && cs.Samples > 0 {
			catSum += cs.PassRate
			catN++
		}
	}
	if catN > 0 {
		signals = append(signals, signal{catSum / catN, 0.25, true})
	}

	var weighted, totalWeight float64
	for _, s := range signals {
		if s.has {
			weighted += s.value * s.weight
			totalWeight += s.weight
		}
	}
	if totalWeight == 0 {
		return 0
	}
	return (weighted / totalWeight) * 100
}
