package store

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"
)

// RoutingLearningCell is one (task_type, complexity bucket, model) aggregate of
// historical outcomes — the raw evidence the routing learner reasons over.
type RoutingLearningCell struct {
	TaskType     string  `json:"task_type"`
	Bucket       string  `json:"bucket"` // low | medium | high
	Model        string  `json:"model"`
	Requests     int64   `json:"requests"`
	Successes    int64   `json:"successes"`
	SuccessRate  float64 `json:"success_rate"` // successes / requests
	FallbackRate float64 `json:"fallback_rate"`
	AvgCostKRW   float64 `json:"avg_cost_krw"`
	AvgLatencyMS float64 `json:"avg_latency_ms"`
	ThumbsUp     int64   `json:"thumbs_up"`
	ThumbsDown   int64   `json:"thumbs_down"`
}

// RoutingRecommendation is the learned "best model" for a (task_type, bucket),
// chosen from cells with enough samples. Advisory — applied only if an operator
// turns it into a routing rule.
type RoutingRecommendation struct {
	TaskType         string  `json:"task_type"`
	Bucket           string  `json:"bucket"`
	RecommendedModel string  `json:"recommended_model"`
	SuccessRate      float64 `json:"success_rate"`
	AvgCostKRW       float64 `json:"avg_cost_krw"`
	Samples          int64   `json:"samples"`
	TopModel         string  `json:"top_model"`        // most-used model in this cell (the de-facto current choice)
	TopSuccessRate   float64 `json:"top_success_rate"` // its success rate, for comparison
	Differs          bool    `json:"differs"`          // recommended != top model
	Confident        bool    `json:"confident"`        // every compared model met the sample floor
	Rationale        string  `json:"rationale"`
}

// RoutingLearning is the full learning report.
type RoutingLearning struct {
	Since           string                  `json:"since"`
	MinSamples      int                     `json:"min_samples"`
	Cells           []RoutingLearningCell   `json:"cells"`
	Recommendations []RoutingRecommendation `json:"recommendations"`
}

// RoutingLearning aggregates chat-completion outcomes by (task_type, bucket, model)
// since `since`, then recommends, per cell, the model with the highest success rate
// among those meeting `minSamples` (ties broken by lower cost, then more samples).
func (s *SQLStore) RoutingLearning(ctx context.Context, since time.Time, minSamples int) (RoutingLearning, error) {
	if minSamples <= 0 {
		minSamples = 20
	}
	out := RoutingLearning{
		Since:           since.UTC().Format(time.RFC3339),
		MinSamples:      minSamples,
		Cells:           []RoutingLearningCell{},
		Recommendations: []RoutingRecommendation{},
	}
	query := s.bind(`
		SELECT
			COALESCE(NULLIF(r.task_type, ''), 'other') AS tt,
			CASE WHEN r.complexity >= 67 THEN 'high' WHEN r.complexity >= 34 THEN 'medium' ELSE 'low' END AS bucket,
			COALESCE(NULLIF(r.model, ''), '(unknown)') AS model,
			COUNT(*) AS requests,
			SUM(CASE WHEN r.status_code >= 200 AND r.status_code < 300 AND COALESCE(r.error, '') = '' AND COALESCE(r.failover, 0) = 0 THEN 1 ELSE 0 END) AS successes,
			SUM(COALESCE(r.failover, 0)) AS fallbacks,
			AVG(r.latency_ms) AS avg_latency,
			AVG(COALESCE(t.estimated_cost, 0)) AS avg_cost,
			SUM(CASE WHEN f.net > 0 THEN 1 ELSE 0 END) AS thumbs_up,
			SUM(CASE WHEN f.net < 0 THEN 1 ELSE 0 END) AS thumbs_down
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		LEFT JOIN (SELECT request_id, SUM(rating) AS net FROM llm_feedback GROUP BY request_id) f ON f.request_id = r.id
		WHERE r.created_at >= ? AND r.endpoint LIKE '%chat/completions%'
		GROUP BY tt, bucket, model
		ORDER BY tt, bucket, requests DESC`)
	rows, err := s.db.QueryContext(ctx, query, since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var c RoutingLearningCell
		var fallbacks int64
		if err := rows.Scan(&c.TaskType, &c.Bucket, &c.Model, &c.Requests, &c.Successes, &fallbacks,
			&c.AvgLatencyMS, &c.AvgCostKRW, &c.ThumbsUp, &c.ThumbsDown); err != nil {
			return out, err
		}
		if c.Requests > 0 {
			c.SuccessRate = float64(c.Successes) / float64(c.Requests)
			c.FallbackRate = float64(fallbacks) / float64(c.Requests)
		}
		out.Cells = append(out.Cells, c)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	out.Recommendations = recommendFromCells(out.Cells, minSamples)
	return out, nil
}

// recommendFromCells groups cells by (task_type, bucket) and picks the best model.
func recommendFromCells(cells []RoutingLearningCell, minSamples int) []RoutingRecommendation {
	type key struct{ tt, bucket string }
	groups := map[key][]RoutingLearningCell{}
	order := []key{}
	for _, c := range cells {
		k := key{c.TaskType, c.Bucket}
		if _, ok := groups[k]; !ok {
			order = append(order, k)
		}
		groups[k] = append(groups[k], c)
	}
	recs := []RoutingRecommendation{}
	for _, k := range order {
		members := groups[k]
		// de-facto current choice = most-used model (cells already arrive requests-desc)
		top := members[0]
		for _, m := range members {
			if m.Requests > top.Requests {
				top = m
			}
		}
		// eligible = models with enough samples
		var eligible []RoutingLearningCell
		for _, m := range members {
			if m.Requests >= int64(minSamples) {
				eligible = append(eligible, m)
			}
		}
		if len(eligible) == 0 {
			continue // not enough evidence to recommend anything for this cell
		}
		best := pickBest(eligible)
		rec := RoutingRecommendation{
			TaskType:         k.tt,
			Bucket:           k.bucket,
			RecommendedModel: best.Model,
			SuccessRate:      best.SuccessRate,
			AvgCostKRW:       best.AvgCostKRW,
			Samples:          best.Requests,
			TopModel:         top.Model,
			TopSuccessRate:   top.SuccessRate,
			Differs:          best.Model != top.Model,
			Confident:        len(eligible) == len(members), // every observed model cleared the floor
		}
		rec.Rationale = buildRationale(rec)
		recs = append(recs, rec)
	}
	// surface actionable (differing) recommendations first
	sort.SliceStable(recs, func(i, j int) bool {
		if recs[i].Differs != recs[j].Differs {
			return recs[i].Differs
		}
		return recs[i].Samples > recs[j].Samples
	})
	return recs
}

// pickBest: highest success rate, ties broken by lower avg cost, then more samples.
func pickBest(cells []RoutingLearningCell) RoutingLearningCell {
	best := cells[0]
	for _, c := range cells[1:] {
		if betterCell(c, best) {
			best = c
		}
	}
	return best
}

func betterCell(a, b RoutingLearningCell) bool {
	const eps = 0.005 // treat <0.5pp success-rate gaps as ties → fall through to cost
	if a.SuccessRate-b.SuccessRate > eps {
		return true
	}
	if b.SuccessRate-a.SuccessRate > eps {
		return false
	}
	if a.AvgCostKRW != b.AvgCostKRW {
		return a.AvgCostKRW < b.AvgCostKRW
	}
	return a.Requests > b.Requests
}

func buildRationale(rec RoutingRecommendation) string {
	var b strings.Builder
	b.WriteString(rec.RecommendedModel)
	b.WriteString(": ")
	b.WriteString(pct(rec.SuccessRate))
	b.WriteString(" 성공")
	if rec.Differs {
		b.WriteString(" (현재 최다 사용 ")
		b.WriteString(rec.TopModel)
		b.WriteString(" ")
		b.WriteString(pct(rec.TopSuccessRate))
		b.WriteString(")")
	}
	if !rec.Confident {
		b.WriteString(" · 일부 모델 표본 부족")
	}
	return b.String()
}

func pct(v float64) string {
	return strconv.Itoa(int(v*100+0.5)) + "%"
}
