package proxy

import "net/http"

func (s *Server) handleFallback(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		stats, err := s.logger.FallbackStats()
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "fallback_stats_failed")
			return
		}
		writeJSON(w, http.StatusOK, stats)
	case http.MethodPost:
		result, err := s.logger.ReplayFallback(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "fallback_replay_failed")
			return
		}
		s.auditAdmin(r, "fallback.replay", "", auditJSON(result))
		writeJSON(w, http.StatusOK, result)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
