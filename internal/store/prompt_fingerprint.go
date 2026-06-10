package store

import (
	"context"
	"strings"
	"time"
)

// PromptFingerprintStat aggregates one cluster of near-identical task prompts.
type PromptFingerprintStat struct {
	Fingerprint    string  `json:"fingerprint"`
	TaskType       string  `json:"task_type"`
	Requests       int64   `json:"requests"`
	AvgCostKRW     float64 `json:"avg_cost_krw"`
	TotalCostKRW   float64 `json:"total_cost_krw"`
	AvgTokens      float64 `json:"avg_tokens"`
	SuccessRate    float64 `json:"success_rate"`
	DistinctModels int64   `json:"distinct_models"`
	TopModel       string  `json:"top_model"`      // most-used model for this prompt shape
	CheapestModel  string  `json:"cheapest_model"` // lowest avg cost among models with decent success
	SamplePrompt   string  `json:"sample_prompt"`  // a redacted example, truncated
	LastSeen       string  `json:"last_seen"`
}

// PromptFingerprints returns the most frequent prompt clusters since `since`,
// each with cost/tokens/success and the de-facto + cost-optimal model.
func (s *SQLStore) PromptFingerprints(ctx context.Context, since time.Time, limit int) ([]PromptFingerprintStat, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := s.bind(`
		SELECT r.prompt_fingerprint,
			COALESCE(NULLIF(MAX(r.task_type), ''), 'other') AS task_type,
			COUNT(*) AS requests,
			AVG(COALESCE(t.estimated_cost, 0)) AS avg_cost,
			SUM(COALESCE(t.estimated_cost, 0)) AS total_cost,
			AVG(COALESCE(t.total_tokens, 0)) AS avg_tokens,
			SUM(CASE WHEN r.status_code >= 200 AND r.status_code < 300 AND COALESCE(r.error, '') = '' AND COALESCE(r.failover, 0) = 0 THEN 1 ELSE 0 END) AS successes,
			COUNT(DISTINCT NULLIF(r.model, '')) AS distinct_models,
			MIN(r.id) AS rep_id,
			MAX(r.created_at) AS last_seen
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ? AND r.endpoint LIKE '%chat/completions%' AND COALESCE(r.prompt_fingerprint, '') <> ''
		GROUP BY r.prompt_fingerprint
		ORDER BY requests DESC
		LIMIT ?`)
	rows, err := s.db.QueryContext(ctx, query, since.UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := []PromptFingerprintStat{}
	repByFP := map[string]string{} // fingerprint -> representative request id
	for rows.Next() {
		var st PromptFingerprintStat
		var successes int64
		var repID string
		if err := rows.Scan(&st.Fingerprint, &st.TaskType, &st.Requests, &st.AvgCostKRW, &st.TotalCostKRW,
			&st.AvgTokens, &successes, &st.DistinctModels, &repID, &st.LastSeen); err != nil {
			return nil, err
		}
		if st.Requests > 0 {
			st.SuccessRate = float64(successes) / float64(st.Requests)
		}
		repByFP[st.Fingerprint] = repID
		result = append(result, st)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return result, nil
	}

	// Per-fingerprint model breakdown → top (most-used) and cheapest-adequate model.
	for i := range result {
		top, cheap, err := s.fingerprintModels(ctx, result[i].Fingerprint, since)
		if err != nil {
			return nil, err
		}
		result[i].TopModel = top
		result[i].CheapestModel = cheap
	}
	// Attach a representative redacted prompt for each cluster.
	if err := s.attachSamplePrompts(ctx, result, repByFP); err != nil {
		return nil, err
	}
	return result, nil
}

// fingerprintModels returns the most-used model and the cheapest model whose
// success rate is within 5pp of the best (a cost-optimal-but-still-good pick).
func (s *SQLStore) fingerprintModels(ctx context.Context, fp string, since time.Time) (top, cheapest string, err error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(r.model, ''), '(unknown)') AS model,
			COUNT(*) AS requests,
			AVG(COALESCE(t.estimated_cost, 0)) AS avg_cost,
			AVG(CASE WHEN r.status_code >= 200 AND r.status_code < 300 AND COALESCE(r.error, '') = '' AND COALESCE(r.failover, 0) = 0 THEN 1.0 ELSE 0.0 END) AS success_rate
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.prompt_fingerprint = ? AND r.created_at >= ?
		GROUP BY model`), fp, since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return "", "", err
	}
	defer rows.Close()
	type mrow struct {
		model       string
		requests    int64
		avgCost     float64
		successRate float64
	}
	var models []mrow
	var bestSuccess float64
	for rows.Next() {
		var m mrow
		if err := rows.Scan(&m.model, &m.requests, &m.avgCost, &m.successRate); err != nil {
			return "", "", err
		}
		if m.successRate > bestSuccess {
			bestSuccess = m.successRate
		}
		models = append(models, m)
	}
	if err := rows.Err(); err != nil {
		return "", "", err
	}
	var topReqs int64 = -1
	cheapestCost := -1.0
	for _, m := range models {
		if m.requests > topReqs {
			topReqs = m.requests
			top = m.model
		}
		// cheapest model whose success rate is within 5pp of the best observed
		if m.successRate+0.05 >= bestSuccess && (cheapestCost < 0 || m.avgCost < cheapestCost) {
			cheapestCost = m.avgCost
			cheapest = m.model
		}
	}
	if cheapest == "" {
		cheapest = top
	}
	return top, cheapest, nil
}

// attachSamplePrompts fills SamplePrompt for each cluster from its representative
// request's first user prompt (one batched query over the rep ids).
func (s *SQLStore) attachSamplePrompts(ctx context.Context, stats []PromptFingerprintStat, repByFP map[string]string) error {
	if len(repByFP) == 0 {
		return nil
	}
	ids := make([]string, 0, len(repByFP))
	placeholders := make([]string, 0, len(repByFP))
	args := make([]any, 0, len(repByFP))
	for _, id := range repByFP {
		ids = append(ids, id)
		placeholders = append(placeholders, "?")
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT request_id, COALESCE(redacted_text, '')
		FROM prompt_logs
		WHERE request_id IN (`+strings.Join(placeholders, ",")+`) AND role = 'user'
		ORDER BY created_at ASC`), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	sampleByReq := map[string]string{}
	for rows.Next() {
		var reqID, text string
		if err := rows.Scan(&reqID, &text); err != nil {
			return err
		}
		if _, seen := sampleByReq[reqID]; !seen { // first user prompt per request
			sampleByReq[reqID] = text
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range stats {
		rep := repByFP[stats[i].Fingerprint]
		stats[i].SamplePrompt = truncatePrompt(sampleByReq[rep], 160)
	}
	return nil
}

func truncatePrompt(s string, max int) string {
	s = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(s, "\n", " "), "\r", " "))
	for strings.Contains(s, "  ") {
		s = strings.ReplaceAll(s, "  ", " ")
	}
	if len([]rune(s)) > max {
		return string([]rune(s)[:max]) + "…"
	}
	return s
}
