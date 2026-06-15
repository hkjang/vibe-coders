package proxy

import (
	"bytes"
	"errors"
	"net/http"
	"strings"

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
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/admin/requests/"), "/replay")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid request id", "invalid_request_error", "invalid_request_id")
		return
	}
	body, endpoint, found, err := s.db.RequestRawBody(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "request_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "replay_failed")
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
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "replay_request_failed")
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
	a := strings.TrimSpace(r.URL.Query().Get("a"))
	b := strings.TrimSpace(r.URL.Query().Get("b"))
	if a == "" || b == "" {
		writeOpenAIError(w, http.StatusBadRequest, "both a and b query params are required", "invalid_request_error", "missing_ids")
		return
	}
	left, err := s.db.RequestDetail(r.Context(), a)
	if err != nil {
		writeOpenAIError(w, http.StatusNotFound, "left request: "+err.Error(), "invalid_request_error", "left_not_found")
		return
	}
	right, err := s.db.RequestDetail(r.Context(), b)
	if err != nil {
		writeOpenAIError(w, http.StatusNotFound, "right request: "+err.Error(), "invalid_request_error", "right_not_found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"left": left, "right": right})
}

// ---------- suggest ----------

var allowedSuggestFields = map[string]bool{"model": true, "ip": true, "language": true, "tag": true}

func (s *Server) handleSuggest(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	field := strings.TrimSpace(r.URL.Query().Get("field"))
	if !allowedSuggestFields[field] {
		writeOpenAIError(w, http.StatusBadRequest, "field must be model/ip/language/tag", "invalid_request_error", "invalid_field")
		return
	}
	values, err := s.db.DistinctValues(r.Context(), field, 100)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "suggest_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"field": field, "values": values})
}
