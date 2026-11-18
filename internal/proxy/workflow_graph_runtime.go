package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"

	"vibe-coders/internal/store"
)

// This private context marker is set only after the HTTP workflow entry has
// authenticated its caller and checked workflow visibility. No request header
// can set it, and MCP-origin workflows never receive it.
type workflowHTTPCallerKey struct{}

func (s *Server) workflowHTTPReentry(r *http.Request, scope string) (*http.Request, error) {
	if r.Context().Value(workflowHTTPCallerKey{}) != true {
		return r, nil
	}
	// Check each live session again at the step boundary. Carry its granted
	// scopes, never permissions inferred from a role or a different API key.
	claims, ok := s.currentAccessClaims(r)
	if !ok || claims.Subject == "" || !hasScope(claims.Scopes, scope) {
		return nil, errGateway("워크플로 단계를 실행할 로그인 상태와 권한을 확인하세요")
	}
	id := ssoPrincipalID(claims.Subject)
	authCtx := store.AuthContext{
		UserID: claims.Subject, TeamID: claims.TeamID, KeyTeam: claims.TeamID,
		Role: claims.Role, Scopes: append([]string(nil), claims.Scopes...), APIKeyID: id,
	}
	s.enrichAuthContextTeam(r.Context(), &authCtx)
	return r.WithContext(withMCPPrincipal(r.Context(), id, &authCtx)), nil
}

// Graph MCP steps use the same authenticated gateway and policy/governance path
// as external tools/call requests. They cannot dispatch local gateway workflow
// tools recursively. Input must be a JSON object; output text feeds the next step.
func (s *Server) workflowMCPToolStep(r *http.Request, step store.WorkflowStep, input string) (string, error) {
	if step.Ref == "" || len(input) > 65536 {
		return "", errGateway("MCP 도구 이름 또는 입력 크기를 확인하세요")
	}
	if len(step.AllowedTools) > 0 {
		allowed := false
		for _, name := range step.AllowedTools {
			if name == step.Ref {
				allowed = true
				break
			}
		}
		if !allowed {
			return "", errGateway("이 단계에서 허용하지 않은 MCP 도구입니다")
		}
	}
	var args map[string]json.RawMessage
	if err := json.Unmarshal([]byte(input), &args); err != nil || args == nil {
		return "", errGateway("MCP 도구 입력은 JSON 객체여야 합니다")
	}
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": "workflow-step", "method": "tools/call",
		"params": map[string]any{"name": step.Ref, "arguments": args},
	})
	if err != nil {
		return "", errGateway("MCP 도구 입력을 만들 수 없습니다")
	}
	caller, err := s.workflowHTTPReentry(r, "mcp:use")
	if err != nil {
		return "", err
	}
	req := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(body)).WithContext(caller.Context())
	req.Header = r.Header.Clone()
	req.Header.Set("Content-Type", "application/json")
	req.Header.Del("Content-Length")
	req.RemoteAddr = r.RemoteAddr
	if r.Context().Value(workflowHTTPCallerKey{}) == true {
		// The principal is already verified. Do not reinterpret its HS256 login
		// token as an external RS256 MCP OAuth token when that option is enabled.
		req.Header.Del("Authorization")
	}
	rec := httptest.NewRecorder()
	s.handleMCPGateway(rec, req)
	if rec.Code != http.StatusOK {
		return "", errGateway("MCP 도구 인증 또는 호출에 실패했습니다")
	}
	var response struct {
		Error  json.RawMessage `json:"error"`
		Result *struct {
			IsError bool `json:"isError"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if rec.Body.Len() > 262144 || json.Unmarshal(rec.Body.Bytes(), &response) != nil || (len(response.Error) > 0 && string(response.Error) != "null") || response.Result == nil || response.Result.IsError {
		return "", errGateway("MCP 도구가 오류를 반환했거나 응답 제한을 초과했습니다")
	}
	var parts []string
	for _, content := range response.Result.Content {
		if content.Type == "text" {
			parts = append(parts, content.Text)
		}
	}
	output := strings.Join(parts, "\n")
	if len(output) > 65536 {
		return "", errGateway("MCP 도구의 텍스트 응답이 65536바이트를 초과했습니다")
	}
	return output, nil
}
