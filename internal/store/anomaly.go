package store

import (
	"context"
	"math"
	"sort"
	"strconv"
	"time"
)

// anomalyMinBaseline / anomalyMinRecent guard against noise from tiny samples.
const (
	anomalyMinBaseline = 20
	anomalyMinRecent   = 5
)

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
