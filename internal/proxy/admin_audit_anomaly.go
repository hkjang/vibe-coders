package proxy

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// handleAuditAnomalies scans admin audit logs for suspicious patterns (destructive
// bursts, privilege/scope changes, off-hours activity, high volume) per admin. Read-only.
// GET /admin/audit/anomalies?window=7d&destructive=5&volume=100
func (s *Server) handleAuditAnomalies(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	destructive := intQuery(r, "destructive", 5)
	volume := intQuery(r, "volume", 100)
	anomalies, err := s.db.AdminAuditAnomalies(r.Context(), since, destructive, volume)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "audit_anomalies_failed")
		return
	}
	high := 0
	for _, a := range anomalies {
		if a.Severity == "high" {
			high++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"destructive_threshold": destructive, "volume_threshold": volume,
		"high_severity": high, "anomalies": anomalies,
	})
}

// intQuery reads an int query param, falling back to a default on absence/parse error.
func intQuery(r *http.Request, key string, fallback int) int {
	if raw := strings.TrimSpace(r.URL.Query().Get(key)); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 {
			return v
		}
	}
	return fallback
}
