package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

func (s *Server) handleRequestReadableSubresource(w http.ResponseWriter, r *http.Request, rest string) {
	idx := strings.Index(rest, "/")
	if idx <= 0 {
		writeOpenAIError(w, http.StatusBadRequest, "invalid request id", "invalid_request_error", "invalid_request_id")
		return
	}
	id, sub := rest[:idx], strings.Trim(rest[idx+1:], "/")
	detail, err := s.db.RequestDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "request_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "request_detail_failed")
		return
	}
	if !s.canViewRequestDetail(r, detail.Request) {
		writeOpenAIError(w, http.StatusForbidden, "request is outside your team scope", "permission_error", "cross_team_access_denied")
		return
	}
	s.maskRequestDetail(r, &detail)
	if detail.Readability == nil {
		detail.Readability = &store.RequestReadability{}
	}
	switch sub {
	case "headers":
		if r.Method != http.MethodGet {
			writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"request_id": id, "headers": detail.Readability.Headers})
	case "routing":
		if r.Method != http.MethodGet {
			writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"request_id": id, "routing": detail.Readability.Routing, "model": detail.Readability.Model, "badges": detail.Readability.Badges})
	case "body":
		if r.Method != http.MethodGet {
			writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"request_id": id, "body": requestBodyEvidence(r.Context(), s, id, detail)})
	case "timeline":
		if r.Method != http.MethodGet {
			writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"request_id": id, "timeline": detail.Readability.Timeline, "spans": detail.Spans, "text2sql_spans": detail.Text2SQLSpans, "tools": detail.Tools})
	case "export":
		if r.Method != http.MethodPost {
			writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
			return
		}
		format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
		if format == "md" || format == "markdown" {
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			_, _ = w.Write([]byte(markdownRequestEvidence(r.Context(), s, id, detail)))
			return
		}
		writeJSON(w, http.StatusOK, maskedRequestEvidence(r.Context(), s, id, detail))
	default:
		writeOpenAIError(w, http.StatusNotFound, "not found", "invalid_request_error", "not_found")
	}
}

func requestTeamScopeForCaller(s *Server, r *http.Request) ([]string, bool) {
	teams, scoped, err := requestTeamScopeForCallerChecked(s, r)
	if err != nil {
		// Existing callers cannot return an error from this helper. Preserve their API
		// contract while failing closed instead of accidentally treating the caller as
		// an unrestricted administrator after an identity lookup failure.
		return nil, true
	}
	return teams, scoped
}

// requestTeamScopeForCallerChecked is used by endpoints where a partial success would be
// misleading. It distinguishes an unrestricted administrator from a failed authenticated
// identity lookup, allowing the handler to return a stable server error while staying closed.
func requestTeamScopeForCallerChecked(s *Server, r *http.Request) ([]string, bool, error) {
	if !s.cfg.Auth.Enabled {
		return nil, false, nil
	}
	claims, ok := s.currentAccessClaims(r)
	if !ok {
		return nil, true, errors.New("admin access claims unavailable")
	}
	if claims.Role != "team_admin" {
		return nil, false, nil
	}
	teamID := claims.TeamID
	if teamID == "" || strings.TrimSpace(teamID) != teamID {
		return nil, true, nil
	}
	keys, found, err := s.db.AuthTeamScopeIdentities(r.Context(), teamID)
	if err != nil {
		return nil, true, err
	}
	if !found {
		return nil, true, nil
	}
	return keys, true, nil
}

func (s *Server) canViewRequestDetail(r *http.Request, request store.RecentRequest) bool {
	if !s.cfg.Auth.Enabled {
		return true
	}
	claims, ok := s.currentAccessClaims(r)
	if !ok {
		return false
	}
	if claims.Role != "team_admin" {
		return true
	}
	claimTeamID := claims.TeamID
	if claimTeamID == "" || strings.TrimSpace(claimTeamID) != claimTeamID {
		return false
	}
	keyTeam, err := s.db.GetTeamForAPIKey(r.Context(), request.APIKeyID)
	if err != nil {
		return false
	}
	if keyTeam == "" || strings.TrimSpace(keyTeam) != keyTeam {
		return false
	}
	keys, found, err := s.db.AuthTeamScopeIdentities(r.Context(), claimTeamID)
	if err != nil || !found {
		return false
	}
	for _, key := range keys {
		if keyTeam == key {
			return true
		}
	}
	return false
}

func requestBodyEvidence(ctx context.Context, s *Server, id string, detail store.RequestDetail) map[string]any {
	body := map[string]any{}
	if detail.Readability != nil && detail.Readability.Body != nil {
		for k, v := range detail.Readability.Body {
			body[k] = v
		}
	}
	raw, endpoint, found, err := s.db.RequestRawBody(ctx, id)
	if err == nil && found && strings.TrimSpace(raw) != "" {
		body["raw_available"] = true
		body["raw_endpoint"] = endpoint
		body["masked_raw"] = maskedRawJSON(raw)
	} else {
		body["raw_available"] = false
	}
	return body
}

func maskedRequestEvidence(ctx context.Context, s *Server, id string, detail store.RequestDetail) map[string]any {
	redactPromptDetails(detail.Prompts)
	if detail.Response != nil {
		detail.Response.ResponseTextOptional = audit.Redact(detail.Response.ResponseTextOptional)
	}
	return map[string]any{
		"request_id":  id,
		"request":     detail.Request,
		"readability": detail.Readability,
		"prompts":     detail.Prompts,
		"response":    detail.Response,
		"governance":  detail.Governance,
		"body":        requestBodyEvidence(ctx, s, id, detail),
	}
}

func markdownRequestEvidence(ctx context.Context, s *Server, id string, detail store.RequestDetail) string {
	ev := maskedRequestEvidence(ctx, s, id, detail)
	b, _ := json.MarshalIndent(ev, "", "  ")
	r := detail.Request
	return "# Request Evidence\n\n" +
		"- Request ID: `" + r.ID + "`\n" +
		"- Endpoint: `" + r.Endpoint + "`\n" +
		"- Requested Model: `" + r.RequestedModel + "`\n" +
		"- Resolved Model: `" + r.ResolvedModel + "`\n" +
		"- Upstream Model: `" + r.UpstreamModel + "`\n" +
		"- Provider: `" + r.Provider + "`\n" +
		"- Status: `" + statusString(r.StatusCode) + "`\n\n" +
		"```json\n" + string(b) + "\n```\n"
}

func maskedRawJSON(raw string) any {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return audit.Redact(raw)
	}
	return maskJSONForDisplay(decoded)
}

func statusString(code int) string {
	if code == 0 {
		return "unknown"
	}
	return http.StatusText(code)
}
