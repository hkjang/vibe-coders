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

	apiKeyID, authCtx, ok := s.authenticateProxyContext(r)
	if !ok || authCtx == nil {
		add(doctorCheck{"authorization", "fail", "유효한 Proxy API Key가 없습니다.", "Authorization: Bearer <API_KEY> 헤더를 설정하고 키가 활성·만료 전인지 확인하세요."})
		writeJSON(w, http.StatusOK, map[string]any{"client": client, "overall": "fail", "checks": checks,
			"base_url": requestOrigin(r) + "/v1", "mcp_url": requestOrigin(r) + "/mcp/gateway"})
		return
	}
	add(doctorCheck{"authorization", "pass", "API Key 인증 성공.", ""})

	// Scope.
	if len(authCtx.Scopes) == 0 {
		add(doctorCheck{"scope", "warn", "키에 부여된 scope가 없습니다.", "필요한 scope(self, mcp:use 등)를 키에 부여하세요."})
	} else if isMCP && !hasScope(authCtx.Scopes, "mcp:use") {
		add(doctorCheck{"scope", "warn", "MCP 사용에 mcp:use scope가 권장됩니다.", "키에 mcp:use scope를 추가하세요."})
	} else {
		add(doctorCheck{"scope", "pass", "scope: " + strings.Join(authCtx.Scopes, ", "), ""})
	}

	// Model allowlist.
	if len(authCtx.AllowedModels) > 0 {
		add(doctorCheck{"model_allowlist", "pass", "허용 모델: " + strings.Join(authCtx.AllowedModels, ", "), ""})
	} else {
		add(doctorCheck{"model_allowlist", "pass", "모델 제한 없음(deny 목록만 적용).", ""})
	}

	// Quota.
	if dec, err := s.checkQuotas(r.Context(), apiKeyID, ""); err == nil {
		if dec.Allowed {
			add(doctorCheck{"quota", "pass", "한도 내 사용 중(사용 " + ftoa(dec.CostKRW) + " KRW).", ""})
		} else {
			add(doctorCheck{"quota", "fail", "한도 초과: " + dec.Reason, "관리자에게 한도 상향을 요청하거나 사용량을 줄이세요."})
		}
	}

	// /v1/models reachability (in-process, carries the caller's auth).
	add(s.doctorProbe(r, http.MethodGet, "/v1/models", "v1_models", "/v1/models 응답 정상.", "업스트림/프로바이더 설정과 네트워크를 확인하세요."))

	// MCP checks for MCP clients.
	if isMCP {
		add(s.doctorMCP(r, apiKeyID, authCtx, "initialize", "mcp_initialize"))
		add(s.doctorMCP(r, apiKeyID, authCtx, "tools/list", "mcp_tools_list"))
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"client": client, "overall": worst, "checks": checks,
		"base_url": requestOrigin(r) + "/v1", "mcp_url": requestOrigin(r) + "/mcp/gateway",
		"note": "연결 설정 진단 결과입니다. fail 항목을 우선 수정하세요.",
	})
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
