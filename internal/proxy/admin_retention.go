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
		writeJSON(w, http.StatusOK, s.retentionStatus(r))
	case http.MethodPost:
		if s.retention == nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "retention worker disabled", "server_error", "retention_disabled")
			return
		}
		deleted := s.retention.RunOnce(r.Context())
		s.auditAdmin(r, "retention.run", "", auditJSON(map[string]int64{"deleted": deleted}))
		writeJSON(w, http.StatusOK, s.retentionStatus(r))
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) retentionStatus(r *http.Request) store.RetentionStatus {
	status := store.RetentionStatus{
		RequestDays:  s.cfg.Retention.RequestDays,
		PromptDays:   s.cfg.Retention.PromptDays,
		ResponseDays: s.cfg.Retention.ResponseDays,
	}
	if s.retention != nil {
		status.LastRunAt = s.retention.LastRun()
		status.LastDeleted = s.retention.TotalDeleted()
	}
	if requests, prompts, responses, err := s.db.Counts(r.Context()); err == nil {
		status.Requests = requests
		status.Prompts = prompts
		status.Responses = responses
	}
	return status
}
