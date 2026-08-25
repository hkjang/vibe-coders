package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"

	"vibe-coders/internal/store"
)

// doctorCheck is one connection diagnostic result.
type doctorCheck struct {
	Name   string `json:"name"`
	Status string `json:"status"` // pass | warn | fail
	Detail string `json:"detail"`
	Fix    string `json:"fix,omitempty"`
}

var mcpClients = map[string]bool{"roo": true, "cline": true, "cursor": true, "claude-desktop-mcp": true, "claude": true, "mcp": true}

// handleConnectionDoctor diagnoses a caller's client connection setup: auth, scope, model
// allowlist, quota, /v1/models reachability, and (for MCP clients) /mcp/gateway initialize +
// tools/list. Read-only; returns per-check pass/warn/fail + a fix hint. Anonymous calls report
// auth=fail rather than 401 so the tool can explain the problem. POST /me/connection-doctor
func (s *Server) handleConnectionDoctor(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Client string `json:"client"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	client := strings.ToLower(strings.TrimSpace(p.Client))
	if client == "" {
		client = "openai-sdk"
	}
	isMCP := mcpClients[client]

	checks := []doctorCheck{}
	worst := "pass"
	add := func(c doctorCheck) {
		checks = append(checks, c)
		if doctorRank(c.Status) > doctorRank(worst) {
			worst = c.Status
		}
	}

	// Two ways to reach this: with a Proxy API Key (a real client connection test, e.g. `vibe
	// doctor`) → full live checks; or with a browser JWT session → diagnose against the user's
	// issued keys (we can't replay /v1 or /mcp as a key whose secret we don't hold).
	var (
		scopes        []string
		allowedModels []string
		apiKeyID      string
		liveReplay    bool
		authMode      string
	)
	keyID, authCtx, ok := s.authenticateProxyContext(r)
	if ok && authCtx != nil {
		authMode, scopes, allowedModels, apiKeyID, liveReplay = "proxy_key", authCtx.Scopes, authCtx.AllowedModels, keyID, true
		add(doctorCheck{"authorization", "pass", "Proxy API Key 인증 성공.", ""})
	} else if claims, jok := s.currentAccessClaims(r); jok && strings.TrimSpace(claims.Subject) != "" {
		authMode = "jwt"
		rep, n, found := s.newestActiveUserKey(r, claims.Subject)
		if !found {
			scopes = claims.Scopes
			add(doctorCheck{"authorization", "warn", "브라우저 세션(JWT)으로 로그인됨. 발급된 활성 API Key가 없습니다.", "'내 키'에서 키를 발급한 뒤 개발도구에 Authorization: Bearer 로 설정하세요."})
		} else {
			scopes, allowedModels, apiKeyID = rep.Scopes, rep.AllowedModels, rep.ID
			add(doctorCheck{"authorization", "pass", "브라우저 세션(JWT) 로그인 · 활성 키 " + itoaProxy(n) + "개. 진단 기준 키: " + rep.Name + ". 개발도구에는 발급 키를 Bearer로 설정하세요.", ""})
		}
	} else {
		add(doctorCheck{"authorization", "fail", "유효한 Proxy API Key 또는 로그인 세션이 없습니다.", "Authorization: Bearer <API_KEY> 헤더를 설정하고 키가 활성·만료 전인지 확인하세요."})
		writeJSON(w, http.StatusOK, map[string]any{"client": client, "overall": "fail", "checks": checks,
			"base_url": requestOrigin(r) + "/v1", "mcp_url": requestOrigin(r) + "/mcp/gateway"})
		return
	}

	// Scope.
	if len(scopes) == 0 {
		add(doctorCheck{"scope", "warn", "부여된 scope가 없습니다.", "필요한 scope(mcp:use 등)를 키/역할에 부여하세요."})
	} else if isMCP && !hasScope(scopes, "mcp:use") {
		add(doctorCheck{"scope", "warn", "MCP 사용에 mcp:use scope가 권장됩니다.", "키에 mcp:use scope를 추가하세요."})
	} else {
		add(doctorCheck{"scope", "pass", "scope: " + strings.Join(scopes, ", "), ""})
	}

	// Model allowlist.
	if len(allowedModels) > 0 {
		add(doctorCheck{"model_allowlist", "pass", "허용 모델: " + strings.Join(allowedModels, ", "), ""})
	} else {
		add(doctorCheck{"model_allowlist", "pass", "모델 제한 없음(deny 목록만 적용).", ""})
	}

	// Quota (needs a resolved key).
	if apiKeyID != "" {
		if dec, err := s.checkQuotas(r.Context(), apiKeyID, "", nil); err == nil {
			if dec.Allowed {
				add(doctorCheck{"quota", "pass", "한도 내 사용 중(사용 " + ftoa(dec.CostKRW) + " KRW).", ""})
			} else {
				add(doctorCheck{"quota", "fail", "한도 초과: " + dec.Reason, "관리자에게 한도 상향을 요청하거나 사용량을 줄이세요."})
			}
		}
	}

	if liveReplay {
		// /v1/models reachability (in-process, carries the caller's key).
		add(s.doctorProbe(r, http.MethodGet, "/v1/models", "v1_models", "/v1/models 응답 정상.", "업스트림/프로바이더 설정과 네트워크를 확인하세요."))
		if isMCP {
			add(s.doctorMCP(r, apiKeyID, authCtx, "initialize", "mcp_initialize"))
			add(s.doctorMCP(r, apiKeyID, authCtx, "tools/list", "mcp_tools_list"))
		}
	} else {
		// Browser session: we can't call /v1 or /mcp as the key (no plaintext secret here).
		add(doctorCheck{"endpoint_reachability", "skip", "브라우저 세션에서는 실엔드포인트 도달성 검사를 건너뜁니다.", "`vibe doctor --client " + client + "` 또는 발급 키로 직접 호출해 확인하세요."})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"client": client, "overall": worst, "checks": checks, "auth_mode": authMode,
		"base_url": requestOrigin(r) + "/v1", "mcp_url": requestOrigin(r) + "/mcp/gateway",
		"note": "연결 설정 진단 결과입니다. fail 항목을 우선 수정하세요.",
	})
}

// newestActiveUserKey returns the caller's most recently created active (non-revoked) API key,
// the active-key count, and whether any was found. Used by the doctor in JWT/browser mode.
func (s *Server) newestActiveUserKey(r *http.Request, userID string) (store.APIKeyPublic, int, bool) {
	all, err := s.db.ListAPIKeys(r.Context())
	if err != nil {
		return store.APIKeyPublic{}, 0, false
	}
	var best store.APIKeyPublic
	count := 0
	found := false
	for _, k := range all {
		if k.UserID != userID || k.Status != "active" || k.RevokedAt != "" {
			continue
		}
		count++
		if !found || k.CreatedAt > best.CreatedAt {
			best, found = k, true
		}
	}
	return best, count, found
}

// doctorProbe replays an in-process request to check an endpoint is reachable under the caller's auth.
func (s *Server) doctorProbe(r *http.Request, method, path, name, okDetail, fix string) doctorCheck {
	req := httptest.NewRequest(method, path, nil)
	req = req.WithContext(r.Context())
	if auth := r.Header.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	req.RemoteAddr = r.RemoteAddr
	rec := httptest.NewRecorder()
	s.handleOpenAI(rec, req)
	if rec.Code == http.StatusOK {
		return doctorCheck{name, "pass", okDetail, ""}
	}
	return doctorCheck{name, "fail", path + " 응답 HTTP " + itoaProxy(rec.Code), fix}
}

// doctorMCP verifies a Gateway MCP JSON-RPC method succeeds for the caller.
func (s *Server) doctorMCP(r *http.Request, apiKeyID string, authCtx *store.AuthContext, method, name string) doctorCheck {
	raw := json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"` + method + `"}`)
	resp := s.dispatchGatewayMCP(r, apiKeyID, authCtx, raw)
	if resp != nil && resp.Error == nil {
		return doctorCheck{name, "pass", "/mcp/gateway " + method + " 정상.", ""}
	}
	return doctorCheck{name, "fail", "/mcp/gateway " + method + " 실패.", "MCP 엔드포인트 URL과 Authorization 헤더를 확인하세요."}
}

func doctorRank(s string) int {
	switch s {
	case "fail":
		return 3
	case "warn":
		return 2
	case "pass":
		return 1
	}
	return 0
}
