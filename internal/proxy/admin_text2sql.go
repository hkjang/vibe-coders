package proxy

import (
	"net/http"
	"time"
)

// handleText2SQLAdmin serves the Text2SQL admin tab data: recent query logs +
// aggregate stats over a window.
// GET /admin/text2sql?window=7d
func (s *Server) handleText2SQLAdmin(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	logs, err := s.db.ListText2SQLLogs(r.Context(), recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_logs_failed")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	stats, err := s.db.Text2SQLStatsSince(r.Context(), since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_stats_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": s.cfg.Text2SQL.Enabled,
		"profiles": []map[string]string{
			{"model": "vibe/text2sql-preview", "mode": "preview", "upstream": s.cfg.Text2SQL.PreviewModel},
			{"model": "vibe/text2sql-execute", "mode": "execute", "upstream": s.cfg.Text2SQL.ExecuteModel},
			{"model": "vibe/text2sql-accurate", "mode": "preview", "upstream": s.cfg.Text2SQL.AccurateModel},
			{"model": "vibe/text2sql-local", "mode": "preview", "upstream": s.cfg.Text2SQL.LocalModel},
			{"model": "vibe/text2sql-auto", "mode": "auto", "upstream": "(complexity 기반)"},
		},
		"stats": stats,
		"logs":  logs,
	})
}
