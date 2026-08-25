package store

import (
	"context"
	"time"
)

// ModelMigrationAdvice recommends, for one prompt-fingerprint cluster, switching from the
// currently-dominant model to a cheaper model whose observed success rate is within 5pp of
// the best in the cluster. EstimatedSavingsKRW projects the window's savings if all of the
// cluster's requests had used the recommended model. Read-only advisory.
type ModelMigrationAdvice struct {
	Fingerprint            string  `json:"fingerprint"`
	TaskType               string  `json:"task_type"`
	Requests               int64   `json:"requests"`
	CurrentModel           string  `json:"current_model"`
	RecommendedModel       string  `json:"recommended_model"`
	CurrentAvgCostKRW      float64 `json:"current_avg_cost_krw"`
	RecommendedAvgCostKRW  float64 `json:"recommended_avg_cost_krw"`
	CurrentSuccessRate     float64 `json:"current_success_rate"`
	RecommendedSuccessRate float64 `json:"recommended_success_rate"`
	EstimatedSavingsKRW    float64 `json:"estimated_savings_krw"`
}

// ModelMigrationAdvice returns migration recommendations for the busiest prompt clusters
// since `since`, considering only clusters with at least minRequests requests. A cluster
// yields advice when its cheapest adequate model (success within 5pp of best, cheaper than
// the dominant model) differs from the model currently most used. Sorted by estimated
// savings descending.
func (s *SQLStore) ModelMigrationAdvice(ctx context.Context, since time.Time, limit, minRequests int) ([]ModelMigrationAdvice, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if minRequests <= 0 {
		minRequests = 20
	}
	sinceStr := since.UTC().Format(time.RFC3339Nano)
	clusterRows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT r.prompt_fingerprint,
			COALESCE(NULLIF(MAX(r.task_type), ''), 'other'),
			COUNT(*)
		FROM request_logs r
		WHERE r.created_at >= ? AND r.endpoint LIKE '%chat/completions%' AND COALESCE(r.prompt_fingerprint, '') <> ''
		GROUP BY r.prompt_fingerprint
		HAVING COUNT(*) >= ?
		ORDER BY COUNT(*) DESC
		LIMIT ?`), sinceStr, minRequests, limit)
	if err != nil {
		return nil, err
	}
	type cluster struct {
		fp       string
		taskType string
		requests int64
	}
	clusters := []cluster{}
	for clusterRows.Next() {
		var c cluster
		if err := clusterRows.Scan(&c.fp, &c.taskType, &c.requests); err != nil {
			clusterRows.Close()
			return nil, err
		}
		clusters = append(clusters, c)
	}
	clusterRows.Close()
	if err := clusterRows.Err(); err != nil {
		return nil, err
	}

	out := []ModelMigrationAdvice{}
	for _, c := range clusters {
		adv, ok, err := s.migrationForCluster(ctx, c.fp, c.taskType, c.requests, sinceStr)
		if err != nil {
			return nil, err
		}
		if ok {
			out = append(out, adv)
		}
	}
	// Sort by estimated savings descending (simple insertion to avoid importing sort twice).
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].EstimatedSavingsKRW > out[j-1].EstimatedSavingsKRW; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

// migrationForCluster computes a recommendation for one fingerprint by comparing the
// dominant model to the cheapest adequate alternative observed for the same prompt shape.
func (s *SQLStore) migrationForCluster(ctx context.Context, fp, taskType string, requests int64, sinceStr string) (ModelMigrationAdvice, bool, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(r.model, ''), '(unknown)') AS model,
			COUNT(*) AS reqs,
			AVG(COALESCE(t.estimated_cost, 0)) AS avg_cost,
			AVG(CASE WHEN r.status_code >= 200 AND r.status_code < 300 AND COALESCE(r.error, '') = '' AND COALESCE(r.failover, 0) = 0 THEN 1.0 ELSE 0.0 END) AS success_rate
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.prompt_fingerprint = ? AND r.created_at >= ?
		GROUP BY model`), fp, sinceStr)
	if err != nil {
		return ModelMigrationAdvice{}, false, err
	}
	defer rows.Close()
	type mrow struct {
		model       string
		reqs        int64
		avgCost     float64
		successRate float64
	}
	var models []mrow
	var bestSuccess float64
	for rows.Next() {
		var m mrow
		if err := rows.Scan(&m.model, &m.reqs, &m.avgCost, &m.successRate); err != nil {
			return ModelMigrationAdvice{}, false, err
		}
		if m.successRate > bestSuccess {
			bestSuccess = m.successRate
		}
		models = append(models, m)
	}
	if err := rows.Err(); err != nil {
		return ModelMigrationAdvice{}, false, err
	}
	if len(models) < 2 {
		return ModelMigrationAdvice{}, false, nil // nothing to migrate to
	}
	// Dominant model = most requests.
	var current mrow
	var topReqs int64 = -1
	for _, m := range models {
		if m.reqs > topReqs {
			topReqs = m.reqs
			current = m
		}
	}
	// Cheapest model whose success is within 5pp of the best and cheaper than current.
	var candidate mrow
	found := false
	for _, m := range models {
		if m.model == current.model {
			continue
		}
		if m.successRate+0.05 < bestSuccess {
			continue
		}
		if m.avgCost >= current.avgCost {
			continue
		}
		if !found || m.avgCost < candidate.avgCost {
			candidate = m
			found = true
		}
	}
	if !found {
		return ModelMigrationAdvice{}, false, nil
	}
	savings := (current.avgCost - candidate.avgCost) * float64(requests)
	if savings < 0 {
		savings = 0
	}
	return ModelMigrationAdvice{
		Fingerprint:            fp,
		TaskType:               taskType,
		Requests:               requests,
		CurrentModel:           current.model,
		RecommendedModel:       candidate.model,
		CurrentAvgCostKRW:      current.avgCost,
		RecommendedAvgCostKRW:  candidate.avgCost,
		CurrentSuccessRate:     current.successRate,
		RecommendedSuccessRate: candidate.successRate,
		EstimatedSavingsKRW:    savings,
	}, true, nil
}
