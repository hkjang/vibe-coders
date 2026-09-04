package proxy

import (
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// handleWaterfall returns the transaction waterfall for one session.
// GET /admin/waterfall?session_id=<id>&limit=<n>
func (s *Server) handleWaterfall(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	sessionID := strings.TrimSpace(r.URL.Query().Get("session_id"))
	if !adminTraceIdentifierValid(sessionID) {
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
	teams, teamScoped, scopeErr := requestTeamScopeForCallerChecked(s, r)
	if scopeErr != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "waterfall scope could not be resolved", "server_error", "waterfall_scope_failed")
		return
	}
	trace, err := s.db.WaterfallScoped(r.Context(), sessionID, limit, slowMS, teams, teamScoped)
	if err != nil {
		slog.Error("waterfall query failed", "error", err)
		writeOpenAIError(w, http.StatusInternalServerError, "waterfall could not be loaded", "server_error", "waterfall_failed")
		return
	}
	s.projectWaterfallForExternal(r, &trace)
	writeJSON(w, http.StatusOK, trace)
}

func (s *Server) projectWaterfallForExternal(r *http.Request, trace *store.WaterfallTrace) {
	if trace == nil || s.canViewRawPrompts(r) {
		return
	}
	rawProviders := make([]string, 0, len(trace.Spans)*2)
	for _, span := range trace.Spans {
		rawProviders = append(rawProviders, span.Provider, span.FallbackFrom)
	}
	projectionArgs := s.externalCredentialProjectionArgs(rawProviders...)
	projectText := func(value string) string {
		return audit.Redact(boundedExternalProviderText(value, projectionArgs...))
	}
	projectLabel := func(value string) string {
		return audit.Redact(boundedExternalProviderLabelOrEmpty(value, projectionArgs...))
	}

	trace.SessionID = projectText(trace.SessionID)
	trace.StartedAt = projectText(trace.StartedAt)
	for index := range trace.Spans {
		span := &trace.Spans[index]
		span.RequestID = projectText(span.RequestID)
		span.TraceID = projectText(span.TraceID)
		span.Model = projectText(span.Model)
		span.RequestedModel = projectText(span.RequestedModel)
		span.Provider = projectLabel(span.Provider)
		span.Endpoint = projectText(span.Endpoint)
		span.Category = projectText(span.Category)
		span.FallbackFrom = projectLabel(span.FallbackFrom)
		span.CreatedAt = projectText(span.CreatedAt)
	}
}
