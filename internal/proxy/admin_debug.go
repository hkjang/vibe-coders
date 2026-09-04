package proxy

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

func (s *Server) handleRequestReplay(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	id, valid := adminTracePathID(r.URL.Path, "/admin/requests/", "/replay")
	if !valid {
		writeOpenAIError(w, http.StatusBadRequest, "invalid request id", "invalid_request_error", "invalid_request_id")
		return
	}
	if !s.canViewRawPrompts(r) {
		writeOpenAIError(w, http.StatusForbidden, "raw request replay requires privileged trace access", "permission_error", "raw_trace_access_denied")
		return
	}
	detail, err := s.db.RequestDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "request_not_found")
			return
		}
		slog.Error("request replay lookup failed", "request_id", id, "error", err)
		writeOpenAIError(w, http.StatusInternalServerError, "request lookup failed", "server_error", "request_lookup_failed")
		return
	}
	if !s.canViewRequestDetail(r, detail.Request) {
		writeOpenAIError(w, http.StatusForbidden, "request is outside your team scope", "permission_error", "cross_team_access_denied")
		return
	}
	body, endpoint, found, err := s.db.RequestRawBody(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "request_not_found")
			return
		}
		slog.Error("request replay body lookup failed", "request_id", id, "error", err)
		writeOpenAIError(w, http.StatusInternalServerError, "request replay lookup failed", "server_error", "replay_failed")
		return
	}
	if !found || body == "" {
		writeOpenAIError(w, http.StatusUnprocessableEntity,
			"raw body not stored for this request (set LOG_RAW_BODIES=true to enable replay)",
			"invalid_request_error", "body_not_stored")
		return
	}

	upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, bytes.NewReader([]byte(body)))
	if err != nil {
		slog.Error("request replay construction failed", "request_id", id, "error", err)
		writeOpenAIError(w, http.StatusInternalServerError, "replay request could not be created", "server_error", "replay_request_failed")
		return
	}
	upstream.URL.Path = endpoint
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("X-Proxy-Replay-Of", id)
	if p := strings.TrimSpace(r.URL.Query().Get("provider")); p != "" {
		upstream.Header.Set("X-Proxy-Provider", p)
	}
	rec := &captureWriter{header: http.Header{}, status: 200}
	s.handleOpenAI(rec, upstream)
	s.auditAdmin(r, "request.replay", auditJSON(map[string]string{"id": id, "endpoint": endpoint}), "")

	contentType := rec.header.Get("Content-Type")
	w.Header().Set("X-Replay-Of", id)
	if strings.Contains(contentType, "text/event-stream") {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(rec.status)
	_, _ = w.Write(rec.body.Bytes())
}

type captureWriter struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func (c *captureWriter) Header() http.Header { return c.header }
func (c *captureWriter) Write(p []byte) (int, error) {
	return c.body.Write(p)
}
func (c *captureWriter) WriteHeader(status int) { c.status = status }
func (c *captureWriter) Flush()                 {}

var _ http.Flusher = (*captureWriter)(nil)
var _ http.ResponseWriter = (*captureWriter)(nil)

// ---------- diff ----------

func (s *Server) handleRequestDiff(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	query := r.URL.Query()
	aValues, aPresent := query["a"]
	bValues, bPresent := query["b"]
	if !aPresent || !bPresent || len(aValues) == 0 || len(bValues) == 0 || strings.TrimSpace(aValues[0]) == "" || strings.TrimSpace(bValues[0]) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "both a and b query params are required", "invalid_request_error", "missing_ids")
		return
	}
	if len(aValues) != 1 || len(bValues) != 1 {
		writeOpenAIError(w, http.StatusBadRequest, "a and b query params must be provided once", "invalid_request_error", "invalid_request_ids")
		return
	}
	a := strings.TrimSpace(aValues[0])
	b := strings.TrimSpace(bValues[0])
	if !adminTraceIdentifierValid(a) || !adminTraceIdentifierValid(b) {
		writeOpenAIError(w, http.StatusBadRequest, "invalid request id", "invalid_request_error", "invalid_request_id")
		return
	}
	left, err := s.db.RequestDetail(r.Context(), a)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "left request not found", "invalid_request_error", "left_not_found")
			return
		}
		slog.Error("left request diff lookup failed", "request_id", a, "error", err)
		writeOpenAIError(w, http.StatusInternalServerError, "request diff lookup failed", "server_error", "request_diff_failed")
		return
	}
	right, err := s.db.RequestDetail(r.Context(), b)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "right request not found", "invalid_request_error", "right_not_found")
			return
		}
		slog.Error("right request diff lookup failed", "request_id", b, "error", err)
		writeOpenAIError(w, http.StatusInternalServerError, "request diff lookup failed", "server_error", "request_diff_failed")
		return
	}
	if !s.canViewRequestDetail(r, left.Request) || !s.canViewRequestDetail(r, right.Request) {
		writeOpenAIError(w, http.StatusForbidden, "request is outside your team scope", "permission_error", "cross_team_access_denied")
		return
	}
	s.maskRequestDetail(r, &left) // data-scope masking for lower-privilege admins
	s.maskRequestDetail(r, &right)
	writeJSON(w, http.StatusOK, map[string]any{"left": left, "right": right})
}

// ---------- suggest ----------

var allowedSuggestFields = map[string]bool{"model": true, "ip": true, "language": true, "tag": true}

func (s *Server) handleSuggest(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	field := strings.TrimSpace(r.URL.Query().Get("field"))
	if !allowedSuggestFields[field] {
		writeOpenAIError(w, http.StatusBadRequest, "field must be model/ip/language/tag", "invalid_request_error", "invalid_field")
		return
	}
	teams, teamScoped, scopeErr := requestTeamScopeForCallerChecked(s, r)
	if scopeErr != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "team scope lookup failed", "server_error", "team_scope_failed")
		return
	}
	values, err := s.db.DistinctValuesScoped(r.Context(), field, 100, teams, teamScoped)
	if err != nil {
		slog.Error("admin suggestion query failed", "field", field, "error", err)
		writeOpenAIError(w, http.StatusInternalServerError, "suggestion query failed", "server_error", "suggest_failed")
		return
	}
	if !s.canViewRawPrompts(r) {
		values = maskSuggestValuesForExternal(field, values, s.externalCredentialProjectionArgs()...)
	}
	writeJSON(w, http.StatusOK, map[string]any{"field": field, "values": values})
}

func maskSuggestValuesForExternal(field string, values []string, projectionArgs ...string) []string {
	masked := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if field == "ip" {
			var valid bool
			value, valid = validatedExternalIPAddress(value)
			if !valid {
				continue
			}
		} else {
			value = audit.Redact(boundedExternalProviderText(value, projectionArgs...))
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		masked = append(masked, value)
	}
	return masked
}
