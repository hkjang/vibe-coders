package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// handleGatewayMCP exposes vibe-coders' OWN features as an MCP server (JSON-RPC 2.0) so external
// agents (Claude, Cursor, Roo Code, Cline) call the gateway as standard MCP tools/resources/
// prompts. Distinct from /mcp (which aggregates UPSTREAM MCP servers). Runs every tool under the
// calling API key's own permissions. POST /mcp/gateway
func (s *Server) handleGatewayMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	apiKeyID, authCtx, ok := s.authenticateProxyContext(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid proxy API key", "invalid_request_error", "invalid_api_key")
		return
	}
	var raw json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		writeJSON(w, http.StatusOK, rpcErrorResponse(nil, -32700, "parse error"))
		return
	}
	if strings.HasPrefix(strings.TrimSpace(string(raw)), "[") {
		var batch []json.RawMessage
		if err := json.Unmarshal(raw, &batch); err != nil {
			writeJSON(w, http.StatusOK, rpcErrorResponse(nil, -32700, "parse error"))
			return
		}
		var responses []any
		for _, item := range batch {
			if resp := s.dispatchGatewayMCP(r, apiKeyID, authCtx, item); resp != nil {
				responses = append(responses, resp)
			}
		}
		if len(responses) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		writeJSON(w, http.StatusOK, responses)
		return
	}
	resp := s.dispatchGatewayMCP(r, apiKeyID, authCtx, raw)
	if resp == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) dispatchGatewayMCP(r *http.Request, apiKeyID string, authCtx *store.AuthContext, raw json.RawMessage) *rpcResponse {
	var msg struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return rpcErrorResponse(nil, -32700, "parse error")
	}
	isNotification := len(msg.ID) == 0 || string(msg.ID) == "null"
	switch msg.Method {
	case "initialize":
		return rpcResultResponse(msg.ID, map[string]any{
			"protocolVersion": mcpProtocolVersion,
			"capabilities": map[string]any{
				"tools":     map[string]any{"listChanged": false},
				"resources": map[string]any{"listChanged": false, "subscribe": false},
				"prompts":   map[string]any{"listChanged": false},
			},
			"serverInfo": map[string]any{"name": "vibe-coders-gateway", "version": AppVersion},
		})
	case "notifications/initialized", "notifications/cancelled":
		return nil
	case "ping":
		return rpcResultResponse(msg.ID, map[string]any{})
	case "tools/list":
		return rpcResultResponse(msg.ID, map[string]any{"tools": gatewayToolDefs()})
	case "tools/call":
		return s.gatewayToolsCall(r, apiKeyID, authCtx, msg.ID, msg.Params)
	case "resources/list":
		return rpcResultResponse(msg.ID, map[string]any{"resources": gatewayResourceDefs()})
	case "resources/read":
		return s.gatewayResourcesRead(r, authCtx, msg.ID, msg.Params)
	case "prompts/list":
		return rpcResultResponse(msg.ID, map[string]any{"prompts": gatewayPromptDefs()})
	case "prompts/get":
		return gatewayPromptsGet(msg.ID, msg.Params)
	default:
		if isNotification {
			return nil
		}
		return rpcErrorResponse(msg.ID, -32601, "method not found: "+msg.Method)
	}
}

// handleGatewayMCPInfo returns the gateway MCP catalog (tools/resources/prompts + endpoint) for
// the admin UI to display. Admin-gated; the live JSON-RPC endpoint is /mcp/gateway (API key).
// GET /admin/gateway-mcp/info
func (s *Server) handleGatewayMCPInfo(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"endpoint":         "/mcp/gateway",
		"protocol_version": mcpProtocolVersion,
		"tools":            gatewayToolDefs(),
		"resources":        gatewayResourceDefs(),
		"prompts":          gatewayPromptDefs(),
		"note":             "외부 AI 에이전트가 Proxy API Key로 /mcp/gateway에 MCP JSON-RPC로 연결해 위 tool/resource/prompt를 사용합니다.",
	})
}

// --- tools ---

func gatewayToolDefs() []mcpToolDef {
	obj := func(props string) json.RawMessage {
		return json.RawMessage(`{"type":"object","properties":{` + props + `}}`)
	}
	return []mcpToolDef{
		{Name: "gateway_chat", Description: "Gateway를 통해 chat completion을 실행합니다(기존 /v1 파이프라인·거버넌스·쿼터·라우팅 적용).", InputSchema: obj(`"model":{"type":"string"},"prompt":{"type":"string"},"messages":{"type":"array"}`)},
		{Name: "gateway_run_skill", Description: "등록된 Skill을 적용해 chat을 실행합니다(X-Skill).", InputSchema: obj(`"skill":{"type":"string"},"prompt":{"type":"string"}`)},
		{Name: "gateway_run_text2sql_preview", Description: "자연어 질문을 Text2SQL preview(SQL 생성, 미실행)로 처리합니다.", InputSchema: obj(`"question":{"type":"string"}`)},
		{Name: "gateway_list_models", Description: "사용 가능한 모델 목록과 가격을 조회합니다(호출자 권한 기준).", InputSchema: obj(``)},
		{Name: "gateway_estimate_cost", Description: "모델과 토큰 수로 예상 비용(KRW)을 계산합니다.", InputSchema: obj(`"model":{"type":"string"},"input_tokens":{"type":"integer"},"output_tokens":{"type":"integer"}`)},
		{Name: "gateway_check_quota", Description: "본인/키의 현재 한도 소진 상태를 조회합니다.", InputSchema: obj(``)},
		{Name: "gateway_route_preview", Description: "vibe/auto 라우팅이 어떤 모델/프로바이더를 선택할지 미리봅니다(실행 안 함).", InputSchema: obj(`"model":{"type":"string"},"prompt":{"type":"string"}`)},
		{Name: "gateway_list_skills", Description: "사용 가능한 production Skill 목록을 조회합니다(팀 권한 기준).", InputSchema: obj(``)},
		{Name: "gateway_explain_request", Description: "본인 요청의 모델·비용·라우팅·정책 요약(영수증)을 조회합니다.", InputSchema: obj(`"request_id":{"type":"string"}`)},
		{Name: "gateway_get_usage_summary", Description: "본인 사용량/비용 요약을 조회합니다.", InputSchema: obj(`"window":{"type":"string","description":"예: 7d, 30d"}`)},
	}
}

func (s *Server) gatewayToolsCall(r *http.Request, apiKeyID string, authCtx *store.AuthContext, id, params json.RawMessage) *rpcResponse {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(params, &p); err != nil || strings.TrimSpace(p.Name) == "" {
		return rpcErrorResponse(id, -32602, "invalid params: name is required")
	}
	ctx := r.Context()
	start := time.Now()
	result, err := s.runGatewayTool(ctx, r, apiKeyID, authCtx, p.Name, p.Arguments)
	// Attribute the call to request/audit logs (args hashed/masked by the logger, not stored raw).
	s.logMCPCall(r, apiKeyID, "gateway", p.Name, p.Arguments, err != nil, ternaryInt(err != nil, 500, 200), time.Since(start).Milliseconds())
	if err != nil {
		return rpcResultResponse(id, gatewayToolError(err.Error()))
	}
	return rpcResultResponse(id, result)
}

// runGatewayTool executes one read-only gateway tool under the caller's permissions and returns
// an MCP tool result. No upstream model call, no tool execution, nothing mutated.
func (s *Server) runGatewayTool(ctx context.Context, r *http.Request, apiKeyID string, authCtx *store.AuthContext, name string, args json.RawMessage) (map[string]any, error) {
	switch name {
	case "gateway_chat":
		var a struct {
			Model    string            `json:"model"`
			Prompt   string            `json:"prompt"`
			Messages []json.RawMessage `json:"messages"`
		}
		_ = json.Unmarshal(args, &a)
		msgs := a.Messages
		if len(msgs) == 0 {
			if strings.TrimSpace(a.Prompt) == "" {
				return nil, errGateway("prompt or messages is required")
			}
			m, _ := json.Marshal(map[string]string{"role": "user", "content": a.Prompt})
			msgs = []json.RawMessage{m}
		}
		reqBody := map[string]any{"model": firstNonEmpty(a.Model, "vibe/auto"), "messages": msgs, "stream": false}
		content, err := s.runGatewayChat(r, reqBody, nil)
		if err != nil {
			return nil, err
		}
		return gatewayToolJSON(map[string]any{"model": firstNonEmpty(a.Model, "vibe/auto"), "content": content}), nil

	case "gateway_run_skill":
		var a struct {
			Skill  string `json:"skill"`
			Prompt string `json:"prompt"`
		}
		_ = json.Unmarshal(args, &a)
		if strings.TrimSpace(a.Skill) == "" || strings.TrimSpace(a.Prompt) == "" {
			return nil, errGateway("skill and prompt are required")
		}
		msg, _ := json.Marshal(map[string]string{"role": "user", "content": a.Prompt})
		body := map[string]any{"model": "vibe/auto", "messages": []json.RawMessage{msg}, "stream": false}
		content, err := s.runGatewayChat(r, body, map[string]string{"X-Skill": a.Skill})
		if err != nil {
			return nil, err
		}
		return gatewayToolJSON(map[string]any{"skill": a.Skill, "content": content}), nil

	case "gateway_run_text2sql_preview":
		var a struct {
			Question string `json:"question"`
		}
		_ = json.Unmarshal(args, &a)
		if strings.TrimSpace(a.Question) == "" {
			return nil, errGateway("question is required")
		}
		msg, _ := json.Marshal(map[string]string{"role": "user", "content": a.Question})
		body := map[string]any{"model": "vibe/text2sql-preview", "messages": []json.RawMessage{msg}, "stream": false}
		content, err := s.runGatewayChat(r, body, nil)
		if err != nil {
			return nil, err
		}
		return gatewayToolJSON(map[string]any{"mode": "preview", "content": content}), nil

	case "gateway_list_models":
		pricing := s.pricingMap(ctx)
		models := []map[string]any{}
		for m, pr := range pricing {
			if authCtx != nil && !listAllows(m, authCtx.AllowedModels, authCtx.DeniedModels) {
				continue
			}
			models = append(models, map[string]any{"model": m, "input_krw_per_1m": pr.InputKRWPer1M, "output_krw_per_1m": pr.OutputKRWPer1M})
		}
		sort.Slice(models, func(i, j int) bool { return models[i]["model"].(string) < models[j]["model"].(string) })
		return gatewayToolJSON(map[string]any{"models": models, "count": len(models)}), nil

	case "gateway_estimate_cost":
		var a struct {
			Model        string `json:"model"`
			InputTokens  int64  `json:"input_tokens"`
			OutputTokens int64  `json:"output_tokens"`
		}
		_ = json.Unmarshal(args, &a)
		pr, found := lookupModelPrice(a.Model, s.pricingMap(ctx))
		if !found {
			return nil, errGateway("unknown model: " + a.Model)
		}
		cost := float64(a.InputTokens)/1e6*pr.InputKRWPer1M + float64(a.OutputTokens)/1e6*pr.OutputKRWPer1M
		return gatewayToolJSON(map[string]any{"model": a.Model, "input_tokens": a.InputTokens, "output_tokens": a.OutputTokens, "estimated_cost_krw": round1(cost)}), nil

	case "gateway_check_quota":
		dec, err := s.checkQuotas(ctx, apiKeyID, "")
		if err != nil {
			return nil, err
		}
		return gatewayToolJSON(map[string]any{"allowed": dec.Allowed, "reason": dec.Reason, "tokens_used": dec.Tokens, "cost_krw": round1(dec.CostKRW), "period_end": dec.PeriodEnd.UTC().Format(time.RFC3339)}), nil

	case "gateway_route_preview":
		var a struct {
			Model  string `json:"model"`
			Prompt string `json:"prompt"`
		}
		_ = json.Unmarshal(args, &a)
		body, _ := json.Marshal(map[string]any{
			"model": firstNonEmpty(a.Model, "vibe/auto"),
			"messages": []map[string]string{{"role": "user", "content": firstNonEmpty(a.Prompt, "preview")}},
		})
		plan := s.planIntelligentRouting(ctx, body, "/v1/chat/completions", false, false, authCtx)
		return gatewayToolJSON(map[string]any{
			"requested_model": plan.RequestedModel, "selected_model": plan.SelectedModel,
			"selected_provider": plan.SelectedProvider, "reason": firstNonEmpty(plan.DecisionReason, plan.RouteReason),
			"complexity_tier": plan.Complexity.Tier, "risk_tier": plan.Risk.Tier, "fallback_path": plan.FallbackPath,
		}), nil

	case "gateway_list_skills":
		skills, err := s.db.ListSkills(ctx, "production")
		if err != nil {
			return nil, err
		}
		out := []map[string]any{}
		team := ""
		if authCtx != nil {
			team = authCtx.TeamID
		}
		for _, sk := range skills {
			if !skillVisibleToTeam(sk, team) {
				continue
			}
			out = append(out, map[string]any{"name": sk.Name, "description": sk.Description, "risk_level": sk.RiskLevel})
		}
		return gatewayToolJSON(map[string]any{"skills": out, "count": len(out)}), nil

	case "gateway_explain_request":
		var a struct {
			RequestID string `json:"request_id"`
		}
		_ = json.Unmarshal(args, &a)
		reqID := strings.TrimSpace(a.RequestID)
		if reqID == "" {
			return nil, errGateway("request_id is required")
		}
		owner, err := s.db.RequestUserID(ctx, reqID)
		if err != nil {
			return nil, err
		}
		if owner == "" {
			return nil, errGateway("request not found")
		}
		if authCtx == nil || owner != authCtx.UserID {
			return nil, errGateway("this request does not belong to you")
		}
		detail, err := s.db.RequestDetail(ctx, reqID)
		if err != nil {
			return nil, err
		}
		req := detail.Request
		summary := map[string]any{
			"request_id": req.ID, "model": req.Model, "provider": req.Provider,
			"status_code": req.StatusCode, "cost_krw": req.EstimatedCost,
			"tokens": map[string]any{"prompt": req.PromptTokens, "completion": req.CompletionTokens, "total": req.TotalTokens, "cached": req.CachedTokens},
			"cache_hit": req.CachedTokens > 0, "created_at": req.CreatedAt,
		}
		if rd, err := s.db.RoutingDecisionByID(ctx, reqID); err == nil {
			summary["routing"] = map[string]any{"selected_model": rd.SelectedModel, "reason": rd.DecisionReason}
		}
		return gatewayToolJSON(summary), nil

	case "gateway_get_usage_summary":
		var a struct {
			Window string `json:"window"`
		}
		_ = json.Unmarshal(args, &a)
		if authCtx == nil || authCtx.UserID == "" {
			return nil, errGateway("could not identify caller")
		}
		since := parseWindow(a.Window, 30*24*time.Hour, "day")
		u, err := s.db.UserUsageTotalsSince(ctx, authCtx.UserID, since)
		if err != nil {
			return nil, err
		}
		return gatewayToolJSON(map[string]any{"requests": u.Requests, "tokens": u.Tokens, "cost_krw": round1(u.CostKRW), "errors": u.Errors, "since": since.UTC().Format(time.RFC3339)}), nil
	}
	return nil, errGateway("unknown tool: " + name)
}

// runGatewayChat executes a chat completion by replaying it through the real /v1 pipeline in
// process (so auth, governance, quota, routing, and logging all apply identically). Returns the
// assistant message text. Non-streaming.
func (s *Server) runGatewayChat(r *http.Request, body map[string]any, extraHeaders map[string]string) (string, error) {
	enc, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(enc))
	req = req.WithContext(r.Context())
	if auth := r.Header.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}
	req.RemoteAddr = r.RemoteAddr
	rec := httptest.NewRecorder()
	s.handleOpenAI(rec, req)
	if rec.Code != http.StatusOK {
		return "", errGateway("chat failed: HTTP " + itoaProxy(rec.Code))
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		return "", errGateway("could not parse completion")
	}
	if len(parsed.Choices) == 0 {
		return "", errGateway("no completion returned")
	}
	return parsed.Choices[0].Message.Content, nil
}

// --- resources ---

func gatewayResourceDefs() []mcpResource {
	return []mcpResource{
		{URI: "gateway://models", Name: "models", Description: "사용 가능한 모델 목록", MimeType: "application/json"},
		{URI: "gateway://skills", Name: "skills", Description: "사용 가능한 Skill 목록", MimeType: "application/json"},
		{URI: "gateway://usage/me", Name: "usage", Description: "본인 사용량 요약(30일)", MimeType: "application/json"},
		{URI: "gateway://quota/me", Name: "quota", Description: "본인 한도 상태", MimeType: "application/json"},
		{URI: "gateway://onboarding", Name: "onboarding", Description: "MCP/OpenAI SDK 연결 가이드", MimeType: "text/markdown"},
	}
}

func (s *Server) gatewayResourcesRead(r *http.Request, authCtx *store.AuthContext, id, params json.RawMessage) *rpcResponse {
	var p struct {
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.URI == "" {
		return rpcErrorResponse(id, -32602, "invalid params: uri is required")
	}
	ctx := r.Context()
	apiKeyID := ""
	if authCtx != nil {
		apiKeyID = authCtx.APIKeyID
	}
	var text, mime string
	switch p.URI {
	case "gateway://models":
		res, _ := s.runGatewayTool(ctx, r, apiKeyID, authCtx, "gateway_list_models", nil)
		text, mime = gatewayResultText(res), "application/json"
	case "gateway://skills":
		res, _ := s.runGatewayTool(ctx, r, apiKeyID, authCtx, "gateway_list_skills", nil)
		text, mime = gatewayResultText(res), "application/json"
	case "gateway://usage/me":
		res, _ := s.runGatewayTool(ctx, r, apiKeyID, authCtx, "gateway_get_usage_summary", nil)
		text, mime = gatewayResultText(res), "application/json"
	case "gateway://quota/me":
		res, _ := s.runGatewayTool(ctx, r, apiKeyID, authCtx, "gateway_check_quota", nil)
		text, mime = gatewayResultText(res), "application/json"
	case "gateway://onboarding":
		text, mime = gatewayOnboardingMarkdown(), "text/markdown"
	default:
		return rpcErrorResponse(id, -32602, "unknown resource: "+p.URI)
	}
	return rpcResultResponse(id, map[string]any{
		"contents": []map[string]any{{"uri": p.URI, "mimeType": mime, "text": text}},
	})
}

func gatewayOnboardingMarkdown() string {
	return "# vibe-coders 연결 가이드\n\n" +
		"## MCP (Claude Desktop / Cursor / Roo Code / Cline)\n" +
		"```json\n{\n  \"mcpServers\": {\n    \"vibe-gateway\": {\n      \"url\": \"<GATEWAY_BASE_URL>/mcp/gateway\",\n      \"headers\": { \"Authorization\": \"Bearer <YOUR_API_KEY>\" }\n    }\n  }\n}\n```\n\n" +
		"## OpenAI 호환 SDK\n- base_url: `<GATEWAY_BASE_URL>/v1`\n- api_key: 발급받은 Proxy API Key\n- 모델: `vibe/auto` 또는 `gateway_list_models`로 조회\n"
}

// --- prompts ---

func gatewayPromptDefs() []mcpPrompt {
	return []mcpPrompt{
		{Name: "use_gateway_safely", Description: "Gateway를 안전하게 사용하는 기본 안내"},
		{Name: "analyze_my_usage", Description: "본인 사용량/비용 분석 보조"},
		{Name: "choose_best_model", Description: "작업 목적별 모델 추천 보조"},
		{Name: "run_text2sql_report", Description: "저장 리포트 실행 보조"},
		{Name: "create_ai_app_request", Description: "업무 앱 생성 요청 보조"},
	}
}

var gatewayPromptText = map[string]string{
	"use_gateway_safely":    "vibe-coders Gateway를 사용할 때: 1) 작업에 맞는 모델을 고르고(gateway_route_preview/gateway_list_models 참고) 2) 예상 비용을 gateway_estimate_cost로 확인하고 3) 민감정보(비밀번호·키·개인정보)는 프롬프트에 넣지 마세요. 막히면 gateway_explain_request로 사유를 확인하세요.",
	"analyze_my_usage":     "gateway_get_usage_summary로 최근 사용량과 비용을 가져와, 비용 증가 원인(모델 선택·요청량·실패 재시도)을 진단하고 절감 방안을 제안하세요.",
	"choose_best_model":    "작업 유형(코드 리뷰/요약/SQL/긴 문서)을 입력받아, gateway_list_models의 가격과 품질을 고려해 가장 적합한 모델을 추천하세요. 비용 대비 품질을 함께 설명하세요.",
	"run_text2sql_report":  "실행할 저장 리포트와 기간·조건·출력 형식을 입력받아, 안전한 SELECT 기반 질의로 결과를 요약하세요. 원문 SQL은 노출하지 않습니다.",
	"create_ai_app_request": "반복되는 업무를 업무 앱으로 정의하기 위해 목적·입력·사용할 Skill/모델/데이터를 정리해 앱 생성 요청서를 작성하세요.",
}

func gatewayPromptsGet(id, params json.RawMessage) *rpcResponse {
	var p struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Name == "" {
		return rpcErrorResponse(id, -32602, "invalid params: name is required")
	}
	text, ok := gatewayPromptText[p.Name]
	if !ok {
		return rpcErrorResponse(id, -32602, "unknown prompt: "+p.Name)
	}
	return rpcResultResponse(id, map[string]any{
		"description": p.Name,
		"messages": []map[string]any{
			{"role": "user", "content": map[string]any{"type": "text", "text": text}},
		},
	})
}

// --- helpers ---

type gatewayToolErr struct{ msg string }

func (e gatewayToolErr) Error() string { return e.msg }
func errGateway(msg string) error      { return gatewayToolErr{msg} }

// gatewayToolJSON wraps a result object as an MCP tool text-content result.
func gatewayToolJSON(v any) map[string]any {
	b, _ := json.MarshalIndent(v, "", "  ")
	return map[string]any{"content": []map[string]any{{"type": "text", "text": string(b)}}}
}

func gatewayToolError(msg string) map[string]any {
	return map[string]any{"isError": true, "content": []map[string]any{{"type": "text", "text": msg}}}
}

// gatewayResultText pulls the text payload out of a tool result (for resources/read).
func gatewayResultText(res map[string]any) string {
	if res == nil {
		return "{}"
	}
	if content, ok := res["content"].([]map[string]any); ok && len(content) > 0 {
		if t, ok := content[0]["text"].(string); ok {
			return t
		}
	}
	return "{}"
}

func ternaryInt(cond bool, a, b int) int {
	if cond {
		return a
	}
	return b
}
