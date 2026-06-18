package proxy

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/config"
)

// validDWDimensions are the rollup dimensions the daily sink populates.
var validDWDimensions = map[string]bool{"all": true, "model": true, "provider": true, "project": true, "cost_center": true}

// dwReady reports whether the ClickHouse DW (and its daily rollup table) is configured.
func (s *Server) dwReady() (config.ClickHouseConfig, string, bool) {
	cfg := s.chConf()
	table := strings.TrimSpace(cfg.Table)
	if strings.TrimSpace(cfg.URL) == "" || table == "" {
		return cfg, "", false
	}
	return cfg, chTableRef(cfg.Database, table), true
}

// chEscape escapes a string literal for safe interpolation into a ClickHouse query.
func chEscape(s string) string { return strings.ReplaceAll(s, "'", "''") }

// dwQueryJSON runs a read query against ClickHouse and returns the decoded `data` rows.
// It appends `FORMAT JSON` and parses ClickHouse's standard JSON envelope.
func (s *Server) dwQueryJSON(ctx context.Context, cfg config.ClickHouseConfig, query string) ([]map[string]any, error) {
	full := query + " FORMAT JSON"
	key := cfg.URL + "\n" + full
	now := time.Now()
	if s.dwCache != nil {
		if rows, ok := s.dwCache.get(key, now); ok {
			if s.metrics != nil {
				s.metrics.IncDWCacheHit()
			}
			return rows, nil
		}
	}
	if s.metrics != nil {
		s.metrics.IncDWCacheMiss()
	}
	body, code, err := s.clickhouseQuery(ctx, cfg, full)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("clickhouse query failed (%d): %s", code, truncateForError(body))
	}
	var env struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &env); err != nil {
		return nil, fmt.Errorf("decode clickhouse response: %w", err)
	}
	if s.dwCache != nil {
		s.dwCache.put(key, env.Data, now)
	}
	return env.Data, nil
}

func truncateForError(s string) string {
	if len(s) > 200 {
		return s[:200]
	}
	return s
}

// asFloat coerces a ClickHouse JSON value (numbers may arrive as strings for UInt64/Float64).
func asFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		var f float64
		_, _ = fmt.Sscanf(t, "%g", &f)
		return f
	}
	return 0
}

// dwSince resolves the lookback start date (UTC, YYYY-MM-DD) from ?window= (default 30d).
func dwSinceDate(r *http.Request) (string, time.Time) {
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	return since.UTC().Format("2006-01-02"), since
}

// dwScopeClause builds the dimension/dim_value WHERE fragment from a single-dimension filter.
// The daily rollup stores per-dimension aggregates (not a cube), so exactly one dimension is
// scoped at a time: a model/provider/project/cost_center filter selects that dimension row,
// otherwise the global "all" rows are used.
func dwScopeClause(r *http.Request) string {
	for _, dim := range []string{"model", "provider", "project", "cost_center"} {
		if v := strings.TrimSpace(r.URL.Query().Get(dim)); v != "" {
			return "dimension = '" + dim + "' AND dim_value = '" + chEscape(v) + "'"
		}
	}
	return "dimension = 'all'"
}

// handleDWDashboardOverview returns the KPI cards from the daily rollup over the window.
// GET /admin/dw/dashboard/overview?window=&model=&provider=&project=&cost_center=
func (s *Server) handleDWDashboardOverview(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cfg, ref, ok := s.dwReady()
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false})
		return
	}
	sinceStr, _ := dwSinceDate(r)
	q := "SELECT sum(requests) AS requests, sum(tokens) AS tokens, sum(cost_krw) AS cost_krw, sum(errors) AS errors FROM " +
		ref + " FINAL WHERE " + dwScopeClause(r) + " AND day >= '" + sinceStr + "'"
	rows, err := s.dwQueryJSON(r.Context(), cfg, q)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
		return
	}
	requests, tokens, cost, errors := 0.0, 0.0, 0.0, 0.0
	if len(rows) > 0 {
		requests, tokens, cost, errors = asFloat(rows[0]["requests"]), asFloat(rows[0]["tokens"]), asFloat(rows[0]["cost_krw"]), asFloat(rows[0]["errors"])
	}
	errorRate, costPerReq, costPer1k := 0.0, 0.0, 0.0
	if requests > 0 {
		errorRate = errors / requests
		costPerReq = cost / requests
	}
	if tokens > 0 {
		costPer1k = cost / tokens * 1000
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": true, "since": sinceStr,
		"requests": requests, "tokens": tokens, "cost_krw": cost, "errors": errors,
		"error_rate": errorRate, "cost_per_request_krw": costPerReq, "cost_per_1k_tokens_krw": costPer1k,
	})
}

// handleDWDashboardTimeseries returns the daily series for the scoped dimension.
// GET /admin/dw/dashboard/timeseries?window=&model=...
func (s *Server) handleDWDashboardTimeseries(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cfg, ref, ok := s.dwReady()
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false})
		return
	}
	sinceStr, _ := dwSinceDate(r)
	// bucket=day (default) groups by calendar day; bucket=week groups by ISO week (Monday).
	// The daily rollup has day grain, so hour is not available here.
	bucket := strings.TrimSpace(r.URL.Query().Get("bucket"))
	bucketExpr := "day"
	if bucket == "week" {
		bucketExpr = "toMonday(day)"
	} else {
		bucket = "day"
	}
	q := "SELECT toString(" + bucketExpr + ") AS day, sum(requests) AS requests, sum(tokens) AS tokens, sum(cost_krw) AS cost_krw, sum(errors) AS errors FROM " +
		ref + " FINAL WHERE " + dwScopeClause(r) + " AND day >= '" + sinceStr + "' GROUP BY " + bucketExpr + " ORDER BY " + bucketExpr
	rows, err := s.dwQueryJSON(r.Context(), cfg, q)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
		return
	}
	points := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		points = append(points, map[string]any{
			"day": row["day"], "requests": asFloat(row["requests"]), "tokens": asFloat(row["tokens"]),
			"cost_krw": asFloat(row["cost_krw"]), "errors": asFloat(row["errors"]),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"configured": true, "since": sinceStr, "bucket": bucket, "points": points})
}

// handleDWDashboardDimensions returns Top-N rows for a dimension (model/provider/project/cost_center).
// GET /admin/dw/dashboard/dimensions?dimension=model&order_by=cost&limit=10&window=
func (s *Server) handleDWDashboardDimensions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cfg, ref, ok := s.dwReady()
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false})
		return
	}
	dim := strings.TrimSpace(r.URL.Query().Get("dimension"))
	if dim == "" || dim == "all" || !validDWDimensions[dim] {
		writeOpenAIError(w, http.StatusBadRequest, "dimension must be one of model|provider|project|cost_center", "invalid_request_error", "invalid_dimension")
		return
	}
	orderCol := map[string]string{"cost": "cost_krw", "requests": "requests", "tokens": "tokens", "errors": "errors"}[strings.TrimSpace(r.URL.Query().Get("order_by"))]
	if orderCol == "" {
		orderCol = "cost_krw"
	}
	limit := recentLimit(r)
	sinceStr, _ := dwSinceDate(r)
	q := "SELECT dim_value, sum(requests) AS requests, sum(tokens) AS tokens, sum(cost_krw) AS cost_krw, sum(errors) AS errors FROM " +
		ref + " FINAL WHERE dimension = '" + chEscape(dim) + "' AND day >= '" + sinceStr + "' GROUP BY dim_value ORDER BY " +
		orderCol + " DESC LIMIT " + fmt.Sprintf("%d", limit)
	rows, err := s.dwQueryJSON(r.Context(), cfg, q)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
		return
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		reqN := asFloat(row["requests"])
		errN := asFloat(row["errors"])
		rate := 0.0
		if reqN > 0 {
			rate = errN / reqN
		}
		items = append(items, map[string]any{
			"value": row["dim_value"], "requests": reqN, "tokens": asFloat(row["tokens"]),
			"cost_krw": asFloat(row["cost_krw"]), "errors": errN, "error_rate": rate,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"configured": true, "since": sinceStr, "dimension": dim, "order_by": orderCol, "rows": items})
}

// dwText2SQLReady reports whether the Text2SQL fact table is configured for dashboard reads.
func (s *Server) dwText2SQLReady() (config.ClickHouseConfig, string, bool) {
	cfg := s.chConf()
	table := strings.TrimSpace(cfg.Text2SQLFactTable)
	if strings.TrimSpace(cfg.URL) == "" || table == "" {
		return cfg, "", false
	}
	return cfg, chTableRef(cfg.Database, table), true
}

// handleDWDashboardText2SQL summarizes Text2SQL activity from the fact table: totals,
// valid/executed/blocked, per-mode counts, and the top failure categories.
// GET /admin/dw/dashboard/text2sql?window=
func (s *Server) handleDWDashboardText2SQL(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cfg, ref, ok := s.dwText2SQLReady()
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false})
		return
	}
	sinceStr, _ := dwSinceDate(r)
	where := "ts >= '" + sinceStr + "'"

	summary, err := s.dwQueryJSON(r.Context(), cfg, "SELECT count() AS total, sum(valid) AS valid, sum(executed) AS executed, "+
		"sum(reject_reason != '') AS blocked, avg(explain_risk) AS avg_risk, sum(cost_krw) AS cost_krw FROM "+ref+" WHERE "+where)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
		return
	}
	byMode, err := s.dwQueryJSON(r.Context(), cfg, "SELECT mode, count() AS n, sum(executed) AS executed FROM "+ref+" WHERE "+where+" GROUP BY mode ORDER BY n DESC")
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
		return
	}
	failures, err := s.dwQueryJSON(r.Context(), cfg, "SELECT failure_category AS reason, count() AS n FROM "+ref+" WHERE "+where+" AND failure_category != '' GROUP BY failure_category ORDER BY n DESC LIMIT 10")
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
		return
	}

	total, valid, executed, blocked, avgRisk, cost := 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
	if len(summary) > 0 {
		s0 := summary[0]
		total, valid, executed, blocked = asFloat(s0["total"]), asFloat(s0["valid"]), asFloat(s0["executed"]), asFloat(s0["blocked"])
		avgRisk, cost = asFloat(s0["avg_risk"]), asFloat(s0["cost_krw"])
	}
	blockRate := 0.0
	if total > 0 {
		blockRate = blocked / total
	}
	modes := make([]map[string]any, 0, len(byMode))
	for _, m := range byMode {
		modes = append(modes, map[string]any{"mode": m["mode"], "count": asFloat(m["n"]), "executed": asFloat(m["executed"])})
	}
	fails := make([]map[string]any, 0, len(failures))
	for _, f := range failures {
		fails = append(fails, map[string]any{"reason": f["reason"], "count": asFloat(f["n"])})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": true, "since": sinceStr,
		"total": total, "valid": valid, "executed": executed, "blocked": blocked, "block_rate": blockRate,
		"avg_explain_risk": avgRisk, "cost_krw": cost, "by_mode": modes, "failures": fails,
	})
}

// dwRoutingReady reports whether the routing fact table is configured for dashboard reads.
func (s *Server) dwRoutingReady() (config.ClickHouseConfig, string, bool) {
	cfg := s.chConf()
	table := strings.TrimSpace(cfg.RoutingFactTable)
	if strings.TrimSpace(cfg.URL) == "" || table == "" {
		return cfg, "", false
	}
	return cfg, chTableRef(cfg.Database, table), true
}

// handleDWDashboardRouting summarizes intelligent-routing decisions from the routing fact:
// auto-route/fallback counts, average complexity/risk/health, top decision reasons, and the
// most common model rewrites (requested → selected).
// GET /admin/dw/dashboard/routing?window=
func (s *Server) handleDWDashboardRouting(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cfg, ref, ok := s.dwRoutingReady()
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false})
		return
	}
	sinceStr, _ := dwSinceDate(r)
	where := "event_date >= '" + sinceStr + "'"

	summary, err := s.dwQueryJSON(r.Context(), cfg, "SELECT count() AS total, sum(requested_model != selected_model) AS auto_routed, "+
		"sum(fallback_path != '') AS fallback_used, avg(complexity_score) AS avg_complexity, avg(risk_score) AS avg_risk, avg(health_score) AS avg_health FROM "+ref+" FINAL WHERE "+where)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
		return
	}
	reasons, err := s.dwQueryJSON(r.Context(), cfg, "SELECT decision_reason AS reason, count() AS n FROM "+ref+" FINAL WHERE "+where+" AND decision_reason != '' GROUP BY decision_reason ORDER BY n DESC LIMIT 10")
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
		return
	}
	rewrites, err := s.dwQueryJSON(r.Context(), cfg, "SELECT requested_model AS from_model, selected_model AS to_model, count() AS n FROM "+ref+" FINAL WHERE "+where+" AND requested_model != selected_model GROUP BY requested_model, selected_model ORDER BY n DESC LIMIT 10")
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
		return
	}

	total, autoRouted, fallback, avgComplex, avgRisk, avgHealth := 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
	if len(summary) > 0 {
		s0 := summary[0]
		total, autoRouted, fallback = asFloat(s0["total"]), asFloat(s0["auto_routed"]), asFloat(s0["fallback_used"])
		avgComplex, avgRisk, avgHealth = asFloat(s0["avg_complexity"]), asFloat(s0["avg_risk"]), asFloat(s0["avg_health"])
	}
	autoRate := 0.0
	if total > 0 {
		autoRate = autoRouted / total
	}
	reasonRows := make([]map[string]any, 0, len(reasons))
	for _, rr := range reasons {
		reasonRows = append(reasonRows, map[string]any{"reason": rr["reason"], "count": asFloat(rr["n"])})
	}
	rewriteRows := make([]map[string]any, 0, len(rewrites))
	for _, rw := range rewrites {
		rewriteRows = append(rewriteRows, map[string]any{"from": rw["from_model"], "to": rw["to_model"], "count": asFloat(rw["n"])})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": true, "since": sinceStr,
		"total": total, "auto_routed": autoRouted, "auto_route_rate": autoRate, "fallback_used": fallback,
		"avg_complexity": avgComplex, "avg_risk": avgRisk, "avg_health": avgHealth,
		"reasons": reasonRows, "rewrites": rewriteRows,
	})
}

// dwRequestFactReady reports whether the per-request fact table is configured for dashboard reads.
func (s *Server) dwRequestFactReady() (config.ClickHouseConfig, string, bool) {
	cfg := s.chConf()
	table := strings.TrimSpace(cfg.RequestFactTable)
	if strings.TrimSpace(cfg.URL) == "" || table == "" {
		return cfg, "", false
	}
	return cfg, chTableRef(cfg.Database, table), true
}

// dwFactScopeClause builds an AND-joined WHERE fragment from real fact columns. Unlike the
// daily rollup (single-dimension), the request fact stores each dimension as its own column,
// so model/provider/project/cost_center/team filters can be combined.
func dwFactScopeClause(r *http.Request) string {
	clauses := make([]string, 0, 5)
	for _, dim := range []string{"model", "provider", "project", "cost_center", "team"} {
		if v := strings.TrimSpace(r.URL.Query().Get(dim)); v != "" {
			clauses = append(clauses, dim+" = '"+chEscape(v)+"'")
		}
	}
	if len(clauses) == 0 {
		return ""
	}
	return " AND " + strings.Join(clauses, " AND ")
}

// handleDWDashboardLatency returns performance (latency) analytics from the request fact:
// P50/P95/P99 of total latency and time-to-first-chunk (streaming), average/max latency,
// error rate, the streaming share, and per-model P95 latency Top-N.
// GET /admin/dw/dashboard/latency?window=&model=&provider=&project=&cost_center=&team=
func (s *Server) handleDWDashboardLatency(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cfg, ref, ok := s.dwRequestFactReady()
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false})
		return
	}
	sinceStr, _ := dwSinceDate(r)
	where := "event_date >= '" + sinceStr + "'" + dwFactScopeClause(r)

	summary, err := s.dwQueryJSON(r.Context(), cfg, "SELECT count() AS total, "+
		"quantile(0.5)(latency_ms) AS p50, quantile(0.95)(latency_ms) AS p95, quantile(0.99)(latency_ms) AS p99, "+
		"avg(latency_ms) AS avg_ms, max(latency_ms) AS max_ms, "+
		"quantile(0.95)(first_chunk_ms) AS ttfb_p95, sum(stream) AS streamed, "+
		"sum(error_category != 'ok') AS errors FROM "+ref+" FINAL WHERE "+where)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
		return
	}
	byModel, err := s.dwQueryJSON(r.Context(), cfg, "SELECT model, count() AS n, quantile(0.95)(latency_ms) AS p95, "+
		"sum(error_category != 'ok') AS errors FROM "+ref+" FINAL WHERE "+where+" GROUP BY model ORDER BY n DESC LIMIT "+strconv.Itoa(recentLimit(r)))
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
		return
	}

	total, p50, p95, p99, avgMs, maxMs, ttfbP95, streamed, errors := 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
	if len(summary) > 0 {
		s0 := summary[0]
		total, p50, p95, p99 = asFloat(s0["total"]), asFloat(s0["p50"]), asFloat(s0["p95"]), asFloat(s0["p99"])
		avgMs, maxMs, ttfbP95 = asFloat(s0["avg_ms"]), asFloat(s0["max_ms"]), asFloat(s0["ttfb_p95"])
		streamed, errors = asFloat(s0["streamed"]), asFloat(s0["errors"])
	}
	errorRate, streamShare := 0.0, 0.0
	if total > 0 {
		errorRate = errors / total
		streamShare = streamed / total
	}
	models := make([]map[string]any, 0, len(byModel))
	for _, m := range byModel {
		mReq := asFloat(m["n"])
		mErr := asFloat(m["errors"])
		mRate := 0.0
		if mReq > 0 {
			mRate = mErr / mReq
		}
		models = append(models, map[string]any{
			"model": m["model"], "requests": mReq, "p95_ms": asFloat(m["p95"]), "errors": mErr, "error_rate": mRate,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": true, "since": sinceStr, "total": total,
		"p50_ms": p50, "p95_ms": p95, "p99_ms": p99, "avg_ms": avgMs, "max_ms": maxMs,
		"ttfb_p95_ms": ttfbP95, "streamed": streamed, "stream_share": streamShare,
		"errors": errors, "error_rate": errorRate, "by_model": models,
	})
}

// dwEvalFactReady reports whether the LLM-evaluation fact table is configured.
func (s *Server) dwEvalFactReady() (config.ClickHouseConfig, string, bool) {
	cfg := s.chConf()
	table := strings.TrimSpace(cfg.EvalFactTable)
	if strings.TrimSpace(cfg.URL) == "" || table == "" {
		return cfg, "", false
	}
	return cfg, chTableRef(cfg.Database, table), true
}

// dwFeedbackFactReady reports whether the human-feedback fact table is configured.
func (s *Server) dwFeedbackFactReady() (config.ClickHouseConfig, string, bool) {
	cfg := s.chConf()
	table := strings.TrimSpace(cfg.FeedbackFactTable)
	if strings.TrimSpace(cfg.URL) == "" || table == "" {
		return cfg, "", false
	}
	return cfg, chTableRef(cfg.Database, table), true
}

// handleDWDashboardQuality summarizes response quality from two fact tables: automated LLM
// evaluations (ai_eval_fact: score/pass rate, per-category breakdown) and human feedback
// (ai_feedback_fact: rating, positive/negative split, per-label). Either source is optional;
// the panel reports configured:true if at least one is available.
// GET /admin/dw/dashboard/quality?window=
func (s *Server) handleDWDashboardQuality(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	sinceStr, _ := dwSinceDate(r)
	where := "event_date >= '" + sinceStr + "'"

	evalOut := map[string]any{"configured": false}
	if cfg, ref, ok := s.dwEvalFactReady(); ok {
		summary, err := s.dwQueryJSON(r.Context(), cfg, "SELECT count() AS total, avg(score) AS avg_score, sum(passed) AS passed FROM "+ref+" FINAL WHERE "+where)
		if err != nil {
			writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
			return
		}
		byCat, err := s.dwQueryJSON(r.Context(), cfg, "SELECT category, count() AS n, avg(score) AS avg_score, sum(passed) AS passed FROM "+ref+" FINAL WHERE "+where+" GROUP BY category ORDER BY n DESC LIMIT "+strconv.Itoa(recentLimit(r)))
		if err != nil {
			writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
			return
		}
		total, avgScore, passed := 0.0, 0.0, 0.0
		if len(summary) > 0 {
			total, avgScore, passed = asFloat(summary[0]["total"]), asFloat(summary[0]["avg_score"]), asFloat(summary[0]["passed"])
		}
		passRate := 0.0
		if total > 0 {
			passRate = passed / total
		}
		cats := make([]map[string]any, 0, len(byCat))
		for _, c := range byCat {
			cN := asFloat(c["n"])
			cPass := asFloat(c["passed"])
			cRate := 0.0
			if cN > 0 {
				cRate = cPass / cN
			}
			cats = append(cats, map[string]any{"category": c["category"], "count": cN, "avg_score": asFloat(c["avg_score"]), "pass_rate": cRate})
		}
		evalOut = map[string]any{"configured": true, "total": total, "avg_score": avgScore, "pass_rate": passRate, "by_category": cats}
	}

	fbOut := map[string]any{"configured": false}
	if cfg, ref, ok := s.dwFeedbackFactReady(); ok {
		summary, err := s.dwQueryJSON(r.Context(), cfg, "SELECT count() AS total, avg(rating) AS avg_rating, sum(rating > 0) AS positive, sum(rating < 0) AS negative FROM "+ref+" WHERE "+where)
		if err != nil {
			writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
			return
		}
		byLabel, err := s.dwQueryJSON(r.Context(), cfg, "SELECT label, count() AS n FROM "+ref+" WHERE "+where+" AND label != '' GROUP BY label ORDER BY n DESC LIMIT "+strconv.Itoa(recentLimit(r)))
		if err != nil {
			writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
			return
		}
		total, avgRating, positive, negative := 0.0, 0.0, 0.0, 0.0
		if len(summary) > 0 {
			total, avgRating, positive, negative = asFloat(summary[0]["total"]), asFloat(summary[0]["avg_rating"]), asFloat(summary[0]["positive"]), asFloat(summary[0]["negative"])
		}
		positiveRate := 0.0
		if total > 0 {
			positiveRate = positive / total
		}
		labels := make([]map[string]any, 0, len(byLabel))
		for _, l := range byLabel {
			labels = append(labels, map[string]any{"label": l["label"], "count": asFloat(l["n"])})
		}
		fbOut = map[string]any{"configured": true, "total": total, "avg_rating": avgRating, "positive": positive, "negative": negative, "positive_rate": positiveRate, "by_label": labels}
	}

	configured := evalOut["configured"] == true || fbOut["configured"] == true
	writeJSON(w, http.StatusOK, map[string]any{"configured": configured, "since": sinceStr, "eval": evalOut, "feedback": fbOut})
}

// handleDWDashboardRefresh clears the DW dashboard query cache so subsequent panel reads hit
// ClickHouse fresh. Used by the "새로고침" button when an admin wants up-to-the-second numbers
// rather than the cached (up to ~45s old) view. Audited.
// POST /admin/dw/dashboard/refresh
func (s *Server) handleDWDashboardRefresh(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cleared := 0
	if s.dwCache != nil {
		cleared = s.dwCache.clear()
	}
	s.auditAdmin(r, "dw.dashboard.refresh", "", auditJSON(map[string]any{"cleared": cleared}))
	writeJSON(w, http.StatusOK, map[string]any{"status": "refreshed", "cleared": cleared})
}

// handleDWDashboardExportCSV exports the current dashboard view as UTF-8 CSV (Excel-friendly
// BOM). A model/provider/project/cost_center dimension exports its Top-N rows; otherwise the
// daily time series of the 'all' scope is exported.
// GET /admin/dw/dashboard/export.csv?window=&dimension=&order_by=&limit=
func (s *Server) handleDWDashboardExportCSV(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cfg, ref, ok := s.dwReady()
	if !ok {
		writeOpenAIError(w, http.StatusBadRequest, "ClickHouse DW is not configured", "invalid_request_error", "dw_disabled")
		return
	}
	sinceStr, _ := dwSinceDate(r)
	dim := strings.TrimSpace(r.URL.Query().Get("dimension"))
	var header []string
	var query string
	dimensional := dim != "" && dim != "all" && validDWDimensions[dim]
	if dimensional {
		orderCol := map[string]string{"cost": "cost_krw", "requests": "requests", "tokens": "tokens", "errors": "errors"}[strings.TrimSpace(r.URL.Query().Get("order_by"))]
		if orderCol == "" {
			orderCol = "cost_krw"
		}
		header = []string{dim, "requests", "tokens", "cost_krw", "errors"}
		query = "SELECT dim_value, sum(requests) AS requests, sum(tokens) AS tokens, sum(cost_krw) AS cost_krw, sum(errors) AS errors FROM " +
			ref + " FINAL WHERE dimension = '" + chEscape(dim) + "' AND day >= '" + sinceStr + "' GROUP BY dim_value ORDER BY " + orderCol + " DESC LIMIT " + strconv.Itoa(recentLimit(r))
	} else {
		header = []string{"day", "requests", "tokens", "cost_krw", "errors"}
		query = "SELECT toString(day) AS day, sum(requests) AS requests, sum(tokens) AS tokens, sum(cost_krw) AS cost_krw, sum(errors) AS errors FROM " +
			ref + " FINAL WHERE " + dwScopeClause(r) + " AND day >= '" + sinceStr + "' GROUP BY day ORDER BY day"
	}
	rows, err := s.dwQueryJSON(r.Context(), cfg, query)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "dw_query_failed")
		return
	}

	stamp := time.Now().UTC().Format("20060102-150405")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=dw-dashboard-%s.csv", stamp))
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF}) // BOM for Excel UTF-8
	keyCol := "day"
	if dimensional {
		keyCol = "dim_value"
	}
	wr := csv.NewWriter(w)
	_ = wr.Write(header)
	for _, row := range rows {
		_ = wr.Write([]string{
			fmt.Sprintf("%v", row[keyCol]),
			strconv.FormatFloat(asFloat(row["requests"]), 'f', 0, 64),
			strconv.FormatFloat(asFloat(row["tokens"]), 'f', 0, 64),
			strconv.FormatFloat(asFloat(row["cost_krw"]), 'f', 2, 64),
			strconv.FormatFloat(asFloat(row["errors"]), 'f', 0, 64),
		})
	}
	wr.Flush()
	s.auditAdmin(r, "dw.dashboard.export", "", auditJSON(map[string]any{"dimension": dim, "since": sinceStr, "rows": len(rows)}))
}
