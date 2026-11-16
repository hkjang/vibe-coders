package proxy

import (
	"net/http"
	"net/url"
	"time"
)

// This read reuses the legacy overview's scoped aggregate, without loading any
// question, SQL, schema, credential or result content into a summary response.
func (s *Server) handleText2SQLSummary(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, 401, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeOpenAIError(w, 405, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	window := query.Get("window")
	if window == "" && len(query) == 0 {
		window = "24h"
	}
	duration, valid := map[string]time.Duration{"1h": time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}[window]
	if err != nil || !valid || len(query) > 1 || (len(query) == 1 && len(query["window"]) != 1) {
		writeOpenAIError(w, 400, "invalid summary period", "invalid_request_error", "invalid_window")
		return
	}
	teams, scoped, err := requestTeamScopeForCallerChecked(s, r)
	if err != nil {
		writeOpenAIError(w, 500, "Text2SQL scope could not be resolved", "server_error", "text2sql_scope_failed")
		return
	}
	generatedAt := time.Now().UTC()
	since := generatedAt.Add(-duration)
	stats, err := s.db.Text2SQLStatsSinceScoped(r.Context(), since, teams, scoped)
	if err != nil {
		writeOpenAIError(w, 500, "Text2SQL statistics could not be loaded", "server_error", "text2sql_stats_failed")
		return
	}
	writeJSON(w, 200, map[string]any{
		"enabled": s.t2sConf().Enabled, "window": window, "since": since.Format(time.RFC3339Nano),
		"generated_at": generatedAt.Format(time.RFC3339Nano), "stats": stats,
	})
}
