package proxy

import (
	"net/http"
	"strconv"
	"time"
)

// handlePromptFingerprints returns clusters of near-identical task prompts.
// GET /admin/prompts/fingerprints?window=7d&limit=100
func (s *Server) handlePromptFingerprints(w http.ResponseWriter, r *http.Request) {
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
	stats, err := s.db.PromptFingerprints(r.Context(), time.Now().Add(-window), limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "prompt_fingerprints_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"fingerprints": stats})
}
