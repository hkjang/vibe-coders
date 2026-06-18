package proxy

import (
	"net/http"
	"strconv"
)

// handleSystemErrors serves the system errors log API.
// GET  /admin/system-errors?limit=   → list recent system errors
// POST /admin/system-errors/clear    → clear all system errors
func (s *Server) handleSystemErrors(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		limit := 100
		if lStr := r.URL.Query().Get("limit"); lStr != "" {
			if parsed, err := strconv.Atoi(lStr); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		list, err := s.db.ListSystemErrors(r.Context(), limit)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_system_errors_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"errors": list})
	case http.MethodPost:
		if err := s.db.ClearSystemErrors(r.Context()); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "clear_system_errors_failed")
			return
		}
		s.auditAdmin(r, "system_errors.clear", "", "")
		writeJSON(w, http.StatusOK, map[string]any{"status": "cleared"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
