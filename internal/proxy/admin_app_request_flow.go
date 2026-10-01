package proxy

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

const appRequestFlowUnavailableMessage = "현재 조건에서 처리 기록을 확인할 수 없습니다. 목록을 새로 조회하세요."

var (
	appRequestFlowRefPattern     = regexp.MustCompile(`^req_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{21}$`)
	errAppRequestFlowUnavailable = errors.New("app request flow unavailable")
)

// This local read boundary allows deterministic lifecycle tests without changing
// Server.db or introducing hooks into the HTTP route. Production always uses s.db.
type appRequestFlowReader interface {
	AppRequestFlowCandidates(context.Context, time.Time) ([]string, bool, error)
	AppRequestFlowRoot(context.Context, store.AppRequestFlowScope) (store.AppRequestFlowRoot, error)
	AppRequestFlowTools(context.Context, store.AppRequestFlowScope) ([]store.AppRequestFlowTool, bool, error)
	AppRequestFlowText2SQL(context.Context, store.AppRequestFlowScope) ([]store.AppRequestFlowText2SQL, bool, error)
}

type appRequestFlowSpan struct {
	SpanRef    string  `json:"span_ref"`
	ParentRef  *string `json:"parent_ref"`
	Kind       string  `json:"kind"`
	Name       string  `json:"name"`
	Status     string  `json:"status"`
	RecordedAt *string `json:"recorded_at"`
	OffsetMS   *int64  `json:"offset_ms"`
	DurationMS *int64  `json:"duration_ms"`
}

type appRequestFlowCoverage struct {
	Limit     int  `json:"limit"`
	Truncated bool `json:"truncated"`
	Omitted   int  `json:"omitted"`
}

type appRequestFlowResponse struct {
	FlowVersion int                  `json:"flow_version"`
	RequestRef  string               `json:"request_ref"`
	CreatedAt   string               `json:"created_at"`
	GeneratedAt string               `json:"generated_at"`
	Spans       []appRequestFlowSpan `json:"spans"`
	Coverage    struct {
		Tools    appRequestFlowCoverage `json:"tools"`
		Text2SQL appRequestFlowCoverage `json:"text2sql"`
	} `json:"coverage"`
}

func appRequestFlowParams(rawQuery string) (string, time.Time, bool) {
	values, err := url.ParseQuery(rawQuery)
	if err != nil || len(values) != 2 {
		return "", time.Time{}, false
	}
	refs, times := values["request_ref"], values["created_at"]
	if len(refs) != 1 || len(times) != 1 || !appRequestFlowRefPattern.MatchString(refs[0]) ||
		len(times[0]) != len(appRequestTimestampLayout) {
		return "", time.Time{}, false
	}
	at, err := time.Parse(appRequestTimestampLayout, times[0])
	if err != nil || at.UTC().Format(appRequestTimestampLayout) != times[0] {
		return "", time.Time{}, false
	}
	return refs[0], at, true
}

func appRequestFlowReference(cipher *secret.Cipher, id string) string {
	digest := cipher.OpaqueReference("app-request", id)
	return appRequestRefPrefix + digest[:appRequestRefFirstLength] + "." + digest[appRequestRefFirstLength:]
}

func (s *Server) handleAppRequestFlow(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "GET 요청만 허용됩니다.", "invalid_request_error", "method_not_allowed")
		return
	}
	// Preserve the existing gateway semantics: invalid credentials AND insufficient
	// admin:read scope return 401 via authorizeAdmin; do not invent a new 403 policy.
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ref, at, valid := appRequestFlowParams(r.URL.RawQuery)
	if !valid {
		writeOpenAIError(w, http.StatusBadRequest, "처리 기록 조회 조건이 올바르지 않습니다.", "invalid_request_error", "invalid_app_request_flow")
		return
	}
	cipher := s.secrets.Load()
	result, err := s.readAppRequestFlow(r, ref, at, cipher, s.db)
	if err != nil {
		if errors.Is(err, errAppRequestFlowUnavailable) || errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, appRequestFlowUnavailableMessage, "invalid_request_error", "app_request_flow_unavailable")
		} else {
			writeOpenAIError(w, http.StatusInternalServerError, "처리 기록을 불러오지 못했습니다.", "server_error", "app_request_flow_failed")
		}
		return
	}
	// No raw identifiers/errors are logged or reflected. A rotated secret never
	// publishes refs assembled under a different epoch.
	if s.secrets.Load() != cipher || r.Context().Err() != nil {
		writeOpenAIError(w, http.StatusNotFound, appRequestFlowUnavailableMessage, "invalid_request_error", "app_request_flow_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) readAppRequestFlow(r *http.Request, ref string, at time.Time, cipher *secret.Cipher, reader appRequestFlowReader) (appRequestFlowResponse, error) {
	var empty appRequestFlowResponse
	teams, scoped, err := requestTeamScopeForCallerChecked(s, r)
	if err != nil {
		return empty, err
	}
	if scoped && len(teams) == 0 {
		return empty, errAppRequestFlowUnavailable
	}
	ids, truncated, err := reader.AppRequestFlowCandidates(r.Context(), at)
	if err != nil {
		return empty, err
	}
	if truncated || len(ids) > store.AppRequestFlowCandidateLimit {
		return empty, errAppRequestFlowUnavailable
	}
	id, matches := "", 0
	for _, candidate := range ids {
		if subtle.ConstantTimeCompare([]byte(ref), []byte(appRequestFlowReference(cipher, candidate))) == 1 {
			id, matches = candidate, matches+1
		}
	}
	if matches != 1 {
		return empty, errAppRequestFlowUnavailable
	}
	scope := store.AppRequestFlowScope{RequestID: id, CreatedAt: at, Teams: teams, TeamScoped: scoped}
	root, err := reader.AppRequestFlowRoot(r.Context(), scope)
	if err != nil {
		return empty, err
	}
	tools, toolsTruncated, err := reader.AppRequestFlowTools(r.Context(), scope)
	if err != nil {
		return empty, err
	}
	sqlSpans, sqlTruncated, err := reader.AppRequestFlowText2SQL(r.Context(), scope)
	if err != nil {
		return empty, err
	}
	result := s.projectAppRequestFlow(ref, at, root, tools, toolsTruncated, sqlSpans, sqlTruncated, cipher)
	// Recheck live session/team evidence before publication. Existing JWT claims
	// and the team identity cache remain authoritative; this is NOT atomic/global
	// revocation or a transaction snapshot across the individual reads.
	if s.cfg.Auth.Enabled {
		claims, valid := s.currentAccessClaims(r)
		if !valid || !hasScope(claims.Scopes, "admin:read") {
			return empty, errAppRequestFlowUnavailable
		}
	}
	teams, scoped, err = requestTeamScopeForCallerChecked(s, r)
	if err != nil {
		return empty, err
	}
	scope.Teams, scope.TeamScoped = teams, scoped
	if _, err = reader.AppRequestFlowRoot(r.Context(), scope); err != nil {
		return empty, err
	}
	if s.secrets.Load() != cipher {
		return empty, errAppRequestFlowUnavailable
	}
	return result, nil
}
