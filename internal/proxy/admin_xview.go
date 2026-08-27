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

// xviewTimeRange resolves the time bounds for XView/scatter queries. When from/to are
// supplied they take precedence and are interpreted in the caller's timezone (tz, default
// Asia/Seoul) — an absent bound stays zero (open-ended). Otherwise the relative window is
// used for the lower bound and the upper bound is left open. A zero lower bound is harmless:
// ScatterPoints' "created_at >= <zero>" matches every row.
func xviewTimeRange(r *http.Request, fallback time.Duration) (since, until time.Time) {
	loc := searchLocation(r.URL.Query().Get("tz"))
	from := parseRangeBound(r.URL.Query().Get("from"), loc, false)
	to := parseRangeBound(r.URL.Query().Get("to"), loc, true)
	if !from.IsZero() || !to.IsZero() {
		return from, to
	}
	return parseWindow(r.URL.Query().Get("window"), fallback, "hour"), time.Time{}
}

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

// xviewAggregateLimit caps how many request rows the XView aggregate endpoints
// (models, model-series, model-outliers) pull before summarizing them in Go. Tests lower
// it so the truncation disclosure can be exercised without seeding twenty thousand rows.
var xviewAggregateLimit = 20000

// xviewAggregatePoints loads the rows an XView aggregate endpoint summarizes and reports
// what the summary actually covers. Rows arrive newest-first and are capped, so a window
// busier than the cap is answered from its most recent slice alone. Every aggregate
// response carries the coverage back: a per-model P95, an hourly series or an outlier set
// computed from part of the requested window is wrong in a way the numbers cannot show.
func (s *Server) xviewAggregatePoints(r *http.Request, since, until time.Time) ([]store.ScatterPoint, map[string]any, error) {
	teams, teamScoped := requestTeamScopeForCaller(s, r)
	points, truncated, err := s.db.ScatterPoints(r.Context(), store.ScatterFilter{
		Since:      since,
		Until:      until,
		Models:     parseModelsParam(r.URL.Query().Get("models")),
		Teams:      teams,
		TeamScoped: teamScoped,
		Limit:      xviewAggregateLimit,
	})
	if err != nil {
		return nil, nil, err
	}
	coverage := map[string]any{
		"truncated":       truncated,
		"sample_size":     len(points),
		"aggregate_limit": xviewAggregateLimit,
	}
	if truncated && len(points) > 0 {
		// Newest-first ordering puts the oldest row the summary saw at the end. Traffic
		// requested before that moment is absent from these numbers, so name the moment
		// rather than leaving the caller to assume the whole window was counted.
		coverage["covered_since"] = points[len(points)-1].CreatedAt
	}
	return points, coverage, nil
}

// withXViewCoverage merges the coverage disclosure into an aggregate response body.
func withXViewCoverage(body, coverage map[string]any) map[string]any {
	for k, v := range coverage {
		body[k] = v
	}
	return body
}

// handleXViewDelta returns request points around a persistence cursor. Unlike request
// created_at, ingested_at is serialized by the database immediately before the completed log
// commits. Clients periodically request reconcile=true for rolling-upgrade compatibility and
// refresh=true to reproject mutable metadata, then deduplicate request_id.
// GET /admin/xview/delta?after_ingested_at=<RFC3339>&after_request_id=<id>&window=1h&reconcile=true
func (s *Server) handleXViewDelta(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}

	rawIngestedAt := strings.TrimSpace(r.URL.Query().Get("after_ingested_at"))
	afterRequestID := strings.TrimSpace(r.URL.Query().Get("after_request_id"))
	if (rawIngestedAt == "") != (afterRequestID == "") {
		writeOpenAIError(w, http.StatusBadRequest, "after_ingested_at and after_request_id must be provided together", "invalid_request_error", "invalid_xview_cursor")
		return
	}
	if len(afterRequestID) > 256 {
		writeOpenAIError(w, http.StatusBadRequest, "after_request_id is too long", "invalid_request_error", "invalid_xview_cursor")
		return
	}
	var after time.Time
	if rawIngestedAt != "" {
		parsed, err := time.Parse(time.RFC3339Nano, rawIngestedAt)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "after_ingested_at must be RFC3339", "invalid_request_error", "invalid_xview_cursor")
			return
		}
		after = parsed
	}
	reconcile := false
	if raw := strings.TrimSpace(r.URL.Query().Get("reconcile")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "reconcile must be true or false", "invalid_request_error", "invalid_xview_reconcile")
			return
		}
		reconcile = parsed
	}
	refresh := false
	if raw := strings.TrimSpace(r.URL.Query().Get("refresh")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "refresh must be true or false", "invalid_request_error", "invalid_xview_refresh")
			return
		}
		refresh = parsed
	}

	f := s.scatterFilterFromRequest(r, 200)
	points, cursor, hasMore, err := s.db.ScatterDelta(r.Context(), f, after, afterRequestID, reconcile, refresh)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "xview_delta_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"points":      points,
		"cursor":      cursor,
		"has_more":    hasMore,
		"server_time": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

// handleXViewModels returns per-model summary for the top N models by call volume.
// GET /admin/xview/models?window=1h&top=10&models=gpt-4.1,gpt-4.1-mini
func (s *Server) handleXViewModels(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since, until := xviewTimeRange(r, time.Hour)
	top := 5
	if v := strings.TrimSpace(r.URL.Query().Get("top")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			top = n
		}
	}
	points, coverage, err := s.xviewAggregatePoints(r, since, until)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "xview_models_failed")
		return
	}
	groups := computeModelGroups(points)
	if len(groups) > top {
		groups = groups[:top]
	}
	writeJSON(w, http.StatusOK, withXViewCoverage(map[string]any{
		"since":  since.UTC().Format(time.RFC3339),
		"top":    top,
		"models": groups,
	}, coverage))
}

// handleXViewModelSeries returns an hourly timeseries per model.
// GET /admin/xview/model-series?window=24h&models=gpt-4.1,gpt-4.1-mini&bucket=hour
func (s *Server) handleXViewModelSeries(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since, until := xviewTimeRange(r, 24*time.Hour)
	// Same timezone the range was parsed in, so the buckets line up with the filter.
	loc := searchLocation(r.URL.Query().Get("tz"))
	bucket := strings.TrimSpace(strings.ToLower(r.URL.Query().Get("bucket")))
	if bucket != "day" {
		bucket = "hour"
	}
	points, coverage, err := s.xviewAggregatePoints(r, since, until)
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
		ts := bucketTimestamp(p.CreatedAt, bucket, loc)
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
	writeJSON(w, http.StatusOK, withXViewCoverage(map[string]any{
		"since":  since.UTC().Format(time.RFC3339),
		"bucket": bucket,
		"series": modelSeries,
	}, coverage))
}

// bucketTimestamp truncates a created_at string to hour or day precision, in the same
// timezone the request filtered by.
//
// The day bucket has to follow the filter. XView's from/to range is parsed in Asia/Seoul
// unless the caller passes ?tz=, so a search for one Seoul day was being answered with
// buckets labelled by UTC day: three requests sent at 01:30, 08:00 and 20:00 on a Seoul
// Monday came back as two days, with the morning filed under Sunday. A bare "2026-08-23"
// carries no offset, so a client cannot correct it afterwards either.
//
// The hour bucket is left as a UTC instant on purpose. Seoul is a whole-hour offset, so
// hour boundaries coincide and the label already names the right moment in a form any
// client can convert — 2026-08-23T23:00:00Z is 08:00 in Seoul. Rewriting it would change
// the text an existing API consumer parses without making it any more correct.
func bucketTimestamp(createdAt, bucket string, loc *time.Location) string {
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
		return t.In(loc).Format("2006-01-02")
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
	since, until := xviewTimeRange(r, time.Hour)
	points, coverage, err := s.xviewAggregatePoints(r, since, until)
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
	writeJSON(w, http.StatusOK, withXViewCoverage(map[string]any{
		"since":    since.UTC().Format(time.RFC3339),
		"outliers": outliers,
	}, coverage))
}
