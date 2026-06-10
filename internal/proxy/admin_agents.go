package proxy

import (
	"net/http"
	"time"
)

// handleAgents returns the per-coding-agent performance leaderboard.
// GET /admin/agents?window=7d
func (s *Server) handleAgents(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	window := parseLearningWindow(r.URL.Query().Get("window"))
	report, err := s.db.AgentAnalytics(r.Context(), time.Now().Add(-window))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "agent_analytics_failed")
		return
	}
	writeJSON(w, http.StatusOK, report)
}
