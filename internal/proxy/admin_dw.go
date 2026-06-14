package proxy

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// handleDWRollups serves long-term analytics rollups and triggers backfill.
// These daily/weekly/monthly aggregates persist beyond detailed-log retention and
// are the source a warehouse (PostgreSQL/ClickHouse) export consumes.
//
// GET  /admin/dw/rollups?dimension=model&period=day|week|month&since=2026-01-01
// POST /admin/dw/rollups?days=30   — backfill the last N days of rollups now
func (s *Server) handleDWRollups(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		dimension := strings.TrimSpace(r.URL.Query().Get("dimension"))
		if dimension == "" {
			dimension = "all"
		}
		period := strings.TrimSpace(r.URL.Query().Get("period"))
		if period == "" {
			period = "day"
		}
		sinceDay := strings.TrimSpace(r.URL.Query().Get("since"))
		if sinceDay == "" {
			sinceDay = time.Now().UTC().AddDate(0, 0, -90).Format("2006-01-02")
		}
		rows, err := s.db.RollupPeriod(r.Context(), dimension, period, sinceDay, recentLimit(r))
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "dw_rollups_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"dimension":  dimension,
			"period":     period,
			"since":      sinceDay,
			"dimensions": []string{"all", "model", "provider", "project", "cost_center"},
			"rows":       rows,
		})
	case http.MethodPost:
		days := 30
		if v := strings.TrimSpace(r.URL.Query().Get("days")); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 && parsed <= 365 {
				days = parsed
			}
		}
		now := time.Now().UTC()
		n, err := s.db.RollupRange(r.Context(), now.AddDate(0, 0, -days), now)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "dw_rollup_failed")
			return
		}
		s.auditAdmin(r, "dw.rollup", "", auditJSON(map[string]int{"days": n}))
		writeJSON(w, http.StatusOK, map[string]any{"rolled_up_days": n})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
