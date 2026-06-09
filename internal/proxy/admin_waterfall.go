package proxy

import (
	"net/http"
	"strconv"
	"strings"
)

// handleWaterfall returns the transaction waterfall for one session.
// GET /admin/waterfall?session_id=<id>&limit=<n>
func (s *Server) handleWaterfall(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	sessionID := strings.TrimSpace(r.URL.Query().Get("session_id"))
	if sessionID == "" {
		writeOpenAIError(w, http.StatusBadRequest, "session_id is required", "invalid_request_error", "missing_session_id")
		return
	}
	limit := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	var slowMS int64
	if v := r.URL.Query().Get("slow_ms"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			slowMS = n
		}
	}
	trace, err := s.db.Waterfall(r.Context(), sessionID, limit, slowMS)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "waterfall_failed")
		return
	}
	writeJSON(w, http.StatusOK, trace)
}
