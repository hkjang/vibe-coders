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
		reason, err := readOperationReason(w, r)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid operation reason", "invalid_request_error", "invalid_operation_reason")
			return
		}
		operationID, err := s.beginAdminOperation(r, "fallback.replay", reason)
		if err != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "operation audit unavailable; replay was not started", "server_error", "operation_audit_unavailable")
			return
		}
		result, err := s.logger.ReplayFallback(r.Context())
		if auditErr := s.finishAdminOperation(r, "fallback.replay", operationID, reason, map[string]any{
			"imported": result.Imported, "duplicates": result.Duplicates, "failed": result.Failed,
			"remaining": result.Remaining, "removed": result.Removed,
		}, err != nil || result.Failed > 0); auditErr != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "replay may have completed; audit confirmation unavailable", "server_error", "operation_result_unconfirmed")
			return
		}
		if err != nil || result.Failed > 0 {
			writeOpenAIError(w, http.StatusInternalServerError, "replay failed or partially completed; check current status before retrying", "server_error", "fallback_replay_failed")
			return
		}
		s.runAdminPostChange(r, "fallback.replay", "", auditJSON(result), "")
		writeJSON(w, http.StatusOK, result)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
