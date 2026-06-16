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
	body, code, err := s.clickhouseQuery(ctx, cfg, query+" FORMAT JSON")
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
	q := "SELECT toString(day) AS day, sum(requests) AS requests, sum(tokens) AS tokens, sum(cost_krw) AS cost_krw, sum(errors) AS errors FROM " +
		ref + " FINAL WHERE " + dwScopeClause(r) + " AND day >= '" + sinceStr + "' GROUP BY day ORDER BY day"
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
	writeJSON(w, http.StatusOK, map[string]any{"configured": true, "since": sinceStr, "bucket": "day", "points": points})
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
