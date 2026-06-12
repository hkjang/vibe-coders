package proxy

import (
	"net/http"
	"strconv"
	"time"
)

// handleTeamBenchmark: GET /admin/benchmark/teams?window=30d
func (s *Server) handleTeamBenchmark(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	window := parseLearningWindow(r.URL.Query().Get("window"))
	rows, err := s.db.TeamBenchmark(r.Context(), time.Now().Add(-window))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "benchmark_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"teams": rows})
}

// handleUserProductivity: GET /admin/benchmark/users?window=30d&limit=100
func (s *Server) handleUserProductivity(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	window := parseLearningWindow(r.URL.Query().Get("window"))
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	rows, err := s.db.UserProductivity(r.Context(), time.Now().Add(-window), limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "productivity_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": rows})
}

// handleIncidents: GET /admin/incidents?window=7d&min_events=5
func (s *Server) handleIncidents(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	window := parseLearningWindow(r.URL.Query().Get("window"))
	minEvents := int64(5)
	if v := r.URL.Query().Get("min_events"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			minEvents = n
		}
	}
	incidents, err := s.db.Incidents(r.Context(), time.Now().Add(-window), minEvents)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "incidents_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"incidents": incidents, "min_events": minEvents})
}
