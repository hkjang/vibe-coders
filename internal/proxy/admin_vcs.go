package proxy

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"vibe-coders/internal/store"
)

// handleVCSWebhook ingests version-control webhooks (GitLab / Bitbucket / generic),
// gated by VCS_WEBHOOK_SECRET. Path: /vcs/webhook/{provider} or /vcs/events (generic).
func (s *Server) handleVCSWebhook(w http.ResponseWriter, r *http.Request) {
	secret := strings.TrimSpace(s.cfg.VCS.WebhookSecret)
	if secret == "" {
		writeOpenAIError(w, http.StatusForbidden, "VCS webhook ingest disabled (set VCS_WEBHOOK_SECRET)", "invalid_request_error", "vcs_disabled")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	// accept the secret from any of the provider-native locations
	presented := firstNonEmpty(
		r.Header.Get("X-Gitlab-Token"),
		r.Header.Get("X-Vibe-VCS-Secret"),
		r.Header.Get("X-Hub-Signature-256"),
		r.URL.Query().Get("token"),
	)
	if subtle.ConstantTimeCompare([]byte(presented), []byte(secret)) != 1 {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid VCS webhook secret", "invalid_request_error", "invalid_secret")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "failed to read body", "invalid_request_error", "invalid_body")
		return
	}
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}

	provider := strings.TrimPrefix(r.URL.Path, "/vcs/webhook/")
	var events []store.VCSEvent
	switch provider {
	case "gitlab":
		events = parseGitLabWebhook(root)
	case "bitbucket":
		events = parseBitbucketWebhook(firstNonEmpty(r.Header.Get("X-Event-Key"), mstr(root, "eventKey")), root)
	default: // /vcs/events generic
		events = parseGenericVCS(root)
	}

	stored, err := s.ingestVCSEvents(r.Context(), events)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "vcs_ingest_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ingested": stored})
}

// parseGenericVCS accepts either a single normalized event or {events:[...]}.
func parseGenericVCS(root map[string]any) []store.VCSEvent {
	if arr := marr(root, "events"); arr != nil {
		out := make([]store.VCSEvent, 0, len(arr))
		for _, item := range arr {
			if m, ok := item.(map[string]any); ok {
				out = append(out, genericEvent(m))
			}
		}
		return out
	}
	return []store.VCSEvent{genericEvent(root)}
}

func genericEvent(m map[string]any) store.VCSEvent {
	kind := firstNonEmpty(mstr(m, "kind"), "commit")
	return store.VCSEvent{
		Provider:    firstNonEmpty(mstr(m, "provider"), "generic"),
		Kind:        kind,
		Repo:        mstr(m, "repo"),
		Branch:      mstr(m, "branch"),
		Ref:         firstNonEmpty(mstr(m, "ref"), mstr(m, "sha"), mstr(m, "mr_id")),
		Title:       firstNonEmpty(mstr(m, "title"), mstr(m, "message")),
		URL:         mstr(m, "url"),
		AuthorEmail: mstr(m, "author_email"),
		AuthorName:  mstr(m, "author_name"),
		State:       mstr(m, "state"),
		SessionID:   firstNonEmpty(mstr(m, "session_id"), mstr(m, "vibe_session")),
	}
}

// handleVCSEvents lists correlated VCS events (admin).
// GET /admin/vcs/events?session_id=&repo=&api_key_id=&kind=&limit=
func (s *Server) handleVCSEvents(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	limit := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	events, err := s.db.ListVCSEvents(r.Context(), store.VCSEventFilter{
		SessionID: strings.TrimSpace(r.URL.Query().Get("session_id")),
		Repo:      strings.TrimSpace(r.URL.Query().Get("repo")),
		APIKeyID:  strings.TrimSpace(r.URL.Query().Get("api_key_id")),
		Kind:      strings.TrimSpace(r.URL.Query().Get("kind")),
		Limit:     limit,
	})
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "vcs_list_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}
