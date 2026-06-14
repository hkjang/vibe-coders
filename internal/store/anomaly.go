package store

import (
	"context"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// anomalyMinBaseline / anomalyMinRecent guard against noise from tiny samples.
const (
	anomalyMinBaseline = 20
	anomalyMinRecent   = 5
)

// SessionLoopAnomaly flags a session that repeated the same prompt fingerprint
// many times in a window — the signature of an agent stuck in a loop burning
// tokens/cost without converging.
type SessionLoopAnomaly struct {
	SessionID   string  `json:"session_id"`
	APIKeyID    string  `json:"api_key_id"`
	Fingerprint string  `json:"prompt_fingerprint"`
	Repeats     int64   `json:"repeats"`
	CostKRW     float64 `json:"cost_krw"`
	Tokens      int64   `json:"tokens"`
	FirstSeen   string  `json:"first_seen"`
	LastSeen    string  `json:"last_seen"`
}

// SessionLoopAnomalies finds (session, prompt-fingerprint) pairs repeated at
// least minRepeats times since `since` — likely runaway agent loops. Ordered by
// repeat count, then wasted cost.
func (s *SQLStore) SessionLoopAnomalies(ctx context.Context, since time.Time, minRepeats, limit int) ([]SessionLoopAnomaly, error) {
	if minRepeats <= 0 {
		minRepeats = 5
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := s.bind(`
		SELECT COALESCE(NULLIF(r.session_id, ''), 'trace:' || r.trace_id) AS session_id,
			MAX(COALESCE(r.api_key_id, '')) AS api_key_id,
			r.prompt_fingerprint,
			COUNT(*) AS repeats,
			COALESCE(SUM(t.estimated_cost), 0) AS cost,
			COALESCE(SUM(t.total_tokens), 0) AS tokens,
			MIN(r.created_at) AS first_seen,
			MAX(r.created_at) AS last_seen
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ? AND COALESCE(r.session_id, '') <> '' AND COALESCE(r.prompt_fingerprint, '') <> ''
		GROUP BY COALESCE(NULLIF(r.session_id, ''), 'trace:' || r.trace_id), r.prompt_fingerprint
		HAVING COUNT(*) >= ?
		ORDER BY repeats DESC, cost DESC
		LIMIT ?`)
	rows, err := s.db.QueryContext(ctx, query, since.UTC().Format(time.RFC3339Nano), minRepeats, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SessionLoopAnomaly{}
	for rows.Next() {
		var a SessionLoopAnomaly
		if err := rows.Scan(&a.SessionID, &a.APIKeyID, &a.Fingerprint, &a.Repeats, &a.CostKRW, &a.Tokens, &a.FirstSeen, &a.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

type anomalyAgg struct {
	model string
	// baseline
	baseN     int64
	baseCost  float64 // mean
	baseCostS float64 // mean of squares
	baseLat   float64
	baseLatS  float64
	baseFC    float64
	baseFCS   float64
	// recent
	recN    int64
	recCost float64
	recLat  float64
	recFC   float64
}

// ModelAnomalies compares each model's recent per-request metrics (cost, latency,
// first-chunk) against a longer baseline window and reports z-score outliers.
// baseline samples come from [now-baseline, now-recent); recent from [now-recent, now].
func (s *SQLStore) ModelAnomalies(ctx context.Context, baseline, recent time.Duration, z float64) ([]AnomalyFinding, error) {
	if z <= 0 {
		z = 3
	}
	now := time.Now().UTC()
	recentStart := now.Add(-recent)
	baselineStart := now.Add(-baseline)

	// Conditional AVG(...) ignores NULLs, so AVG(CASE WHEN base THEN x END) is the
	// mean over baseline rows. We also pull AVG(x*x) to derive stddev in Go. Works on
	// both SQLite and PostgreSQL without a STDDEV extension.
	query := s.bind(`
		SELECT COALESCE(NULLIF(r.model, ''), 'unknown') AS model,
			SUM(CASE WHEN r.created_at < ? THEN 1 ELSE 0 END) AS base_n,
			AVG(CASE WHEN r.created_at < ? THEN COALESCE(t.estimated_cost, 0) END) AS base_cost,
			AVG(CASE WHEN r.created_at < ? THEN COALESCE(t.estimated_cost, 0) * COALESCE(t.estimated_cost, 0) END) AS base_cost_sq,
			AVG(CASE WHEN r.created_at < ? THEN r.latency_ms END) AS base_lat,
			AVG(CASE WHEN r.created_at < ? THEN r.latency_ms * r.latency_ms END) AS base_lat_sq,
			AVG(CASE WHEN r.created_at < ? THEN COALESCE(r.first_chunk_ms, 0) END) AS base_fc,
			AVG(CASE WHEN r.created_at < ? THEN COALESCE(r.first_chunk_ms, 0) * COALESCE(r.first_chunk_ms, 0) END) AS base_fc_sq,
			SUM(CASE WHEN r.created_at >= ? THEN 1 ELSE 0 END) AS rec_n,
			AVG(CASE WHEN r.created_at >= ? THEN COALESCE(t.estimated_cost, 0) END) AS rec_cost,
			AVG(CASE WHEN r.created_at >= ? THEN r.latency_ms END) AS rec_lat,
			AVG(CASE WHEN r.created_at >= ? THEN COALESCE(r.first_chunk_ms, 0) END) AS rec_fc
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ?
		GROUP BY COALESCE(NULLIF(r.model, ''), 'unknown')`)

	rs := recentStart.Format(time.RFC3339Nano)
	args := []any{rs, rs, rs, rs, rs, rs, rs, rs, rs, rs, rs, baselineStart.Format(time.RFC3339Nano)}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	findings := []AnomalyFinding{}
	for rows.Next() {
		var a anomalyAgg
		// nullable aggregate scan targets
		var baseCost, baseCostSq, baseLat, baseLatSq, baseFC, baseFCSq nullableFloat
		var recCost, recLat, recFC nullableFloat
		if err := rows.Scan(&a.model, &a.baseN,
			&baseCost, &baseCostSq, &baseLat, &baseLatSq, &baseFC, &baseFCSq,
			&a.recN, &recCost, &recLat, &recFC); err != nil {
			return nil, err
		}
		if a.baseN < anomalyMinBaseline || a.recN < anomalyMinRecent {
			continue
		}
		a.baseCost, a.baseCostS = baseCost.v, baseCostSq.v
		a.baseLat, a.baseLatS = baseLat.v, baseLatSq.v
		a.baseFC, a.baseFCS = baseFC.v, baseFCSq.v
		a.recCost, a.recLat, a.recFC = recCost.v, recLat.v, recFC.v

		add := func(metric string, baseMean, baseMeanSq, recMean float64) {
			std := math.Sqrt(math.Max(0, baseMeanSq-baseMean*baseMean))
			// Relative floor: treat at least 5% of the mean as inherent noise so a
			// perfectly-constant baseline (e.g. identical-cost requests) can still
			// surface a real spike instead of being skipped for std==0.
			if floor := 0.05 * math.Abs(baseMean); floor > std {
				std = floor
			}
			if std <= 0 {
				return
			}
			zs := (recMean - baseMean) / std
			if math.Abs(zs) < z {
				return
			}
			dir := "up"
			if zs < 0 {
				dir = "down"
			}
			findings = append(findings, AnomalyFinding{
				Model: a.model, Metric: metric,
				BaselineMean: baseMean, BaselineStd: std, RecentMean: recMean,
				ZScore: zs, Direction: dir,
				BaselineSamples: a.baseN, RecentSamples: a.recN,
			})
		}
		add("cost_per_request", a.baseCost, a.baseCostS, a.recCost)
		add("latency_ms", a.baseLat, a.baseLatS, a.recLat)
		add("first_chunk_ms", a.baseFC, a.baseFCS, a.recFC)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// strongest anomalies first
	sort.Slice(findings, func(i, j int) bool {
		return math.Abs(findings[i].ZScore) > math.Abs(findings[j].ZScore)
	})
	return findings, nil
}

// MaxAnomalyZ returns the largest absolute z-score among current anomalies (for alerting).
func (s *SQLStore) MaxAnomalyZ(ctx context.Context, baseline, recent time.Duration) (float64, error) {
	// use a low z floor so we capture the true max, then take abs of the top finding
	findings, err := s.ModelAnomalies(ctx, baseline, recent, 0.0001)
	if err != nil {
		return 0, err
	}
	if len(findings) == 0 {
		return 0, nil
	}
	return math.Abs(findings[0].ZScore), nil
}

type costAnomalyBucket struct {
	baseline map[int]float64
	recent   float64
	samples  int64
}

// CostAnomalies compares total KRW spend in the recent window with previous
// same-sized windows across global, api_key, team and model scopes.
func (s *SQLStore) CostAnomalies(ctx context.Context, baseline, recent time.Duration, z float64) ([]CostAnomalyFinding, error) {
	if z <= 0 {
		z = 3
	}
	if recent <= 0 {
		recent = time.Hour
	}
	if baseline <= recent {
		baseline = 7 * 24 * time.Hour
	}
	now := time.Now().UTC()
	recentStart := now.Add(-recent)
	baselineStart := now.Add(-baseline)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT r.created_at, COALESCE(t.estimated_cost, 0),
			COALESCE(NULLIF(r.api_key_id, ''), 'anonymous'),
			COALESCE(NULLIF(k.team, ''), 'unassigned'),
			COALESCE(NULLIF(r.model, ''), 'unknown')
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		LEFT JOIN api_keys k ON k.id = r.api_key_id
		WHERE r.created_at >= ?`), baselineStart.Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	buckets := map[string]*costAnomalyBucket{}
	add := func(scope, value string, when time.Time, cost float64) {
		if value == "" {
			value = "*"
		}
		key := scope + "\x00" + value
		b := buckets[key]
		if b == nil {
			b = &costAnomalyBucket{baseline: map[int]float64{}}
			buckets[key] = b
		}
		if !when.Before(recentStart) {
			b.recent += cost
			b.samples++
			return
		}
		idx := int(recentStart.Sub(when) / recent)
		if idx < 0 {
			idx = 0
		}
		b.baseline[idx] += cost
	}
	for rows.Next() {
		var createdAt string
		var cost float64
		var apiKeyID, team, model string
		if err := rows.Scan(&createdAt, &cost, &apiKeyID, &team, &model); err != nil {
			return nil, err
		}
		when := parseOptionalTime(createdAt)
		if when.IsZero() {
			continue
		}
		add("global", "*", when, cost)
		add("api_key", apiKeyID, when, cost)
		add("team", team, when, cost)
		add("model", model, when, cost)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	findings := []CostAnomalyFinding{}
	for key, bucket := range buckets {
		if bucket.samples < anomalyMinRecent || len(bucket.baseline) < 2 {
			continue
		}
		values := make([]float64, 0, len(bucket.baseline))
		for _, v := range bucket.baseline {
			values = append(values, v)
		}
		mean, std := meanStd(values)
		if floor := 0.05 * math.Abs(mean); floor > std {
			std = floor
		}
		if std <= 0 {
			continue
		}
		zs := (bucket.recent - mean) / std
		if math.Abs(zs) < z {
			continue
		}
		parts := strings.SplitN(key, "\x00", 2)
		dir := "up"
		if zs < 0 {
			dir = "down"
		}
		findings = append(findings, CostAnomalyFinding{
			Scope:           parts[0],
			ScopeValue:      parts[1],
			Metric:          "cost_total",
			BaselineMean:    mean,
			BaselineStd:     std,
			RecentValue:     bucket.recent,
			ZScore:          zs,
			Direction:       dir,
			BaselineBuckets: int64(len(values)),
			RecentSamples:   bucket.samples,
		})
	}
	sort.Slice(findings, func(i, j int) bool {
		return math.Abs(findings[i].ZScore) > math.Abs(findings[j].ZScore)
	})
	return findings, nil
}

func meanStd(values []float64) (float64, float64) {
	if len(values) == 0 {
		return 0, 0
	}
	sum := 0.0
	sumSq := 0.0
	for _, v := range values {
		sum += v
		sumSq += v * v
	}
	mean := sum / float64(len(values))
	variance := math.Max(0, sumSq/float64(len(values))-mean*mean)
	return mean, math.Sqrt(variance)
}

type nullableFloat struct{ v float64 }

func (n *nullableFloat) Scan(src any) error {
	switch t := src.(type) {
	case nil:
		n.v = 0
	case float64:
		n.v = t
	case int64:
		n.v = float64(t)
	case []byte:
		// some drivers hand back numeric as text
		if f, err := strconv.ParseFloat(string(t), 64); err == nil {
			n.v = f
		}
	case string:
		if f, err := strconv.ParseFloat(t, 64); err == nil {
			n.v = f
		}
	}
	return nil
}
