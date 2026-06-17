package proxy

import (
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// parseModelsParam splits a comma-separated ?models= query param into a deduplicated slice.
// Returns nil when the param is absent or empty (= no filter).
func parseModelsParam(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	seen := make(map[string]bool, len(parts))
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

// computeModelGroups aggregates per-model statistics from a slice of scatter points.
func computeModelGroups(points []store.ScatterPoint) []store.ScatterModelGroup {
	type bucket struct {
		latencies  []int64
		firstChunk []float64
		risks      []float64
		health     []float64
		errors     int64
		failovers  int64
		governance int64
		tokens     int64
		cost       float64
		count      int64
	}
	byModel := map[string]*bucket{}
	for _, p := range points {
		m := p.Model
		if m == "" {
			m = "(unknown)"
		}
		b, ok := byModel[m]
		if !ok {
			b = &bucket{}
			byModel[m] = b
		}
		b.count++
		b.latencies = append(b.latencies, p.LatencyMS)
		b.firstChunk = append(b.firstChunk, float64(p.FirstChunkMS))
		b.risks = append(b.risks, float64(p.RiskScore))
		b.health = append(b.health, float64(p.HealthScore))
		b.tokens += p.TotalTokens
		b.cost += p.CostKRW
		if p.StatusCode >= 400 {
			b.errors++
		}
		if p.Failover {
			b.failovers++
		}
		if p.PolicyDecisionCount > 0 {
			b.governance++
		}
	}

	groups := make([]store.ScatterModelGroup, 0, len(byModel))
	for model, b := range byModel {
		sort.Slice(b.latencies, func(i, j int) bool { return b.latencies[i] < b.latencies[j] })
		sort.Float64s(b.risks)
		g := store.ScatterModelGroup{
			Model:           model,
			Count:           b.count,
			ErrorRate:       safeDivF(float64(b.errors), float64(b.count)),
			P50:             percentileInt(b.latencies, 50),
			P95:             percentileInt(b.latencies, 95),
			P99:             percentileInt(b.latencies, 99),
			AvgFirstChunkMS: meanF(b.firstChunk),
			TotalTokens:     b.tokens,
			TotalCostKRW:    b.cost,
			AvgCostKRW:      safeDivF(b.cost, float64(b.count)),
			FailoverCount:   b.failovers,
			GovernanceCount: b.governance,
			RiskP95:         percentileF(b.risks, 95),
			HealthAvg:       meanF(b.health),
		}
		groups = append(groups, g)
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].Count > groups[j].Count })
	return groups
}

func percentileInt(sorted []int64, pct int) int64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(math.Ceil(float64(pct)/100*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

func percentileF(sorted []float64, pct int) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(math.Ceil(float64(pct)/100*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

func meanF(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	var sum float64
	for _, v := range vals {
		sum += v
	}
	return sum / float64(len(vals))
}

func safeDivF(num, den float64) float64 {
	if den == 0 {
		return 0
	}
	return num / den
}

// handleXViewModels returns per-model summary for the top N models by call volume.
// GET /admin/xview/models?window=1h&top=10&models=gpt-4.1,gpt-4.1-mini
func (s *Server) handleXViewModels(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), time.Hour, "hour")
	top := 5
	if v := strings.TrimSpace(r.URL.Query().Get("top")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			top = n
		}
	}
	f := store.ScatterFilter{
		Since:  since,
		Models: parseModelsParam(r.URL.Query().Get("models")),
		Limit:  20000,
	}
	points, _, err := s.db.ScatterPoints(r.Context(), f)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "xview_models_failed")
		return
	}
	groups := computeModelGroups(points)
	if len(groups) > top {
		groups = groups[:top]
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"since":  since.UTC().Format(time.RFC3339),
		"top":    top,
		"models": groups,
	})
}

// handleXViewModelSeries returns an hourly timeseries per model.
// GET /admin/xview/model-series?window=24h&models=gpt-4.1,gpt-4.1-mini&bucket=hour
func (s *Server) handleXViewModelSeries(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 24*time.Hour, "hour")
	bucket := strings.TrimSpace(strings.ToLower(r.URL.Query().Get("bucket")))
	if bucket != "day" {
		bucket = "hour"
	}
	f := store.ScatterFilter{
		Since:  since,
		Models: parseModelsParam(r.URL.Query().Get("models")),
		Limit:  20000,
	}
	points, _, err := s.db.ScatterPoints(r.Context(), f)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "xview_series_failed")
		return
	}

	type seriesBucket struct {
		count   int64
		errors  int64
		latSum  int64
		costSum float64
	}
	// key: "model|bucket-ts"
	type bucketKey struct{ model, ts string }
	data := map[bucketKey]*seriesBucket{}
	for _, p := range points {
		m := p.Model
		if m == "" {
			m = "(unknown)"
		}
		ts := bucketTimestamp(p.CreatedAt, bucket)
		key := bucketKey{model: m, ts: ts}
		b, ok := data[key]
		if !ok {
			b = &seriesBucket{}
			data[key] = b
		}
		b.count++
		b.latSum += p.LatencyMS
		b.costSum += p.CostKRW
		if p.StatusCode >= 400 {
			b.errors++
		}
	}

	type seriesPoint struct {
		Timestamp  string  `json:"ts"`
		Count      int64   `json:"count"`
		ErrorRate  float64 `json:"error_rate"`
		AvgLatency float64 `json:"avg_latency_ms"`
		CostKRW    float64 `json:"cost_krw"`
	}
	modelSeries := map[string][]seriesPoint{}
	for k, b := range data {
		modelSeries[k.model] = append(modelSeries[k.model], seriesPoint{
			Timestamp:  k.ts,
			Count:      b.count,
			ErrorRate:  safeDivF(float64(b.errors), float64(b.count)),
			AvgLatency: safeDivF(float64(b.latSum), float64(b.count)),
			CostKRW:    b.costSum,
		})
	}
	for m := range modelSeries {
		sort.Slice(modelSeries[m], func(i, j int) bool {
			return modelSeries[m][i].Timestamp < modelSeries[m][j].Timestamp
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"since":  since.UTC().Format(time.RFC3339),
		"bucket": bucket,
		"series": modelSeries,
	})
}

// bucketTimestamp truncates a created_at string to hour or day precision.
func bucketTimestamp(createdAt, bucket string) string {
	// createdAt is RFC3339Nano from the store; truncate to bucket granularity.
	t, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		t, err = time.Parse(time.RFC3339, createdAt)
		if err != nil {
			end := len(createdAt)
			if end > 13 {
				end = 13
			}
			return createdAt[:end]
		}
	}
	if bucket == "day" {
		return t.UTC().Format("2006-01-02")
	}
	return t.UTC().Format("2006-01-02T15:00:00Z")
}

// handleXViewModelOutliers returns per-point outlier annotations for the XView scatter.
// A point is an outlier if its latency or risk exceeds the model-group's P95.
// GET /admin/xview/model-outliers?window=1h&models=gpt-4.1
func (s *Server) handleXViewModelOutliers(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), time.Hour, "hour")
	f := store.ScatterFilter{
		Since:  since,
		Models: parseModelsParam(r.URL.Query().Get("models")),
		Limit:  20000,
	}
	points, truncated, err := s.db.ScatterPoints(r.Context(), f)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "xview_outliers_failed")
		return
	}
	groups := computeModelGroups(points)
	p95ByModel := make(map[string]int64, len(groups))
	for _, g := range groups {
		p95ByModel[g.Model] = g.P95
	}

	type outlier struct {
		RequestID string   `json:"request_id"`
		TraceID   string   `json:"trace_id"`
		Model     string   `json:"model"`
		LatencyMS int64    `json:"latency_ms"`
		Tags      []string `json:"tags"`
	}
	outliers := []outlier{}
	for _, p := range points {
		m := p.Model
		if m == "" {
			m = "(unknown)"
		}
		var tags []string
		if p95, ok := p95ByModel[m]; ok && p.LatencyMS > p95 {
			tags = append(tags, "p95_exceeded")
		}
		if p.StatusCode >= 500 {
			tags = append(tags, "error_5xx")
		} else if p.StatusCode >= 400 {
			tags = append(tags, "error_4xx")
		}
		if p.Failover {
			tags = append(tags, "failover")
		}
		if p.PolicyDecisionCount > 0 {
			tags = append(tags, "governance")
		}
		if len(tags) > 0 {
			outliers = append(outliers, outlier{
				RequestID: p.RequestID,
				TraceID:   p.TraceID,
				Model:     m,
				LatencyMS: p.LatencyMS,
				Tags:      tags,
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"since":     since.UTC().Format(time.RFC3339),
		"outliers":  outliers,
		"truncated": truncated,
	})
}
