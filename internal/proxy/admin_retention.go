package proxy

import (
	"net/http"

	"vibe-coders/internal/store"
)

func (s *Server) handleRetention(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.writeRetentionStatus(w, r)
	case http.MethodPost:
		reason, err := readOperationReason(w, r)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid operation reason", "invalid_request_error", "invalid_operation_reason")
			return
		}
		if s.retention == nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "retention worker disabled", "server_error", "retention_disabled")
			return
		}
		operationID, err := s.beginAdminOperation(r, "retention.run", reason)
		if err != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "operation audit unavailable; cleanup was not started", "server_error", "operation_audit_unavailable")
			return
		}
		deleted, runErr := s.retention.RunOnceChecked(r.Context())
		if err := s.finishAdminOperation(r, "retention.run", operationID, reason, map[string]any{"deleted": deleted}, runErr != nil); err != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "cleanup may have completed; audit confirmation unavailable", "server_error", "operation_result_unconfirmed")
			return
		}
		if runErr != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "cleanup failed or partially completed; check current status before retrying", "server_error", "retention_run_incomplete")
			return
		}
		s.runAdminPostChange(r, "retention.run", "", auditJSON(map[string]int64{"deleted": deleted}), "")
		s.writeRetentionStatus(w, r)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) writeRetentionStatus(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg.Retention
	if s.retention != nil {
		cfg = s.retention.Config()
	}
	status := store.RetentionStatus{
		RequestDays:  cfg.RequestDays,
		PromptDays:   cfg.PromptDays,
		ResponseDays: cfg.ResponseDays,
	}
	if s.retention != nil {
		status.LastRunAt = s.retention.LastRun()
		status.LastDeleted = s.retention.TotalDeleted()
	}
	requests, prompts, responses, err := s.db.Counts(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "retention counts unavailable; a previous cleanup may have completed", "server_error", "retention_status_unavailable")
		return
	}
	status.Requests, status.Prompts, status.Responses = requests, prompts, responses
	writeJSON(w, http.StatusOK, status)
}
