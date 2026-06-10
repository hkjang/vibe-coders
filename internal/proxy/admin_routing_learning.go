package proxy

import (
	"net/http"
	"strconv"
	"time"
)

// handleRoutingLearning returns the learned model recommendations per
// (task_type, complexity bucket) from historical outcomes.
// GET /admin/routing/learning?window=7d&min_samples=20
func (s *Server) handleRoutingLearning(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	window := parseLearningWindow(r.URL.Query().Get("window"))
	minSamples := 20
	if v := r.URL.Query().Get("min_samples"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			minSamples = n
		}
	}
	report, err := s.db.RoutingLearning(r.Context(), time.Now().Add(-window), minSamples)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_learning_failed")
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// parseLearningWindow accepts 24h/7d/30d style windows, defaulting to 7 days.
func parseLearningWindow(s string) time.Duration {
	switch s {
	case "24h":
		return 24 * time.Hour
	case "30d":
		return 30 * 24 * time.Hour
	case "90d":
		return 90 * 24 * time.Hour
	case "7d", "":
		return 7 * 24 * time.Hour
	}
	if d, err := time.ParseDuration(s); err == nil && d > 0 {
		return d
	}
	return 7 * 24 * time.Hour
}
