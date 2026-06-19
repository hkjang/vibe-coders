package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// This file turns MCP discovery virtual models (vibe/grounded, vibe/research, ...) into a
// real agentic tool-calling loop: a backing LLM is given the selected upstreams' MCP tools
// as OpenAI function definitions, decides which to call with what arguments, receives the
// results, and either calls more tools or synthesizes a final grounded answer — the same
// 티키타카 loop coding agents (codex/claude/qwen) run. When streaming, the loop's reasoning
// (tool calls + results) is surfaced as reasoning_content deltas while the final answer is
// streamed as content deltas. If no backing model is resolvable, the caller falls back to
// the static evidence rendering.

const (
	mcpAgentMaxToolResultChars = 6000
	mcpAgentMaxTokens          = 1024
)

// mcpAgentRoute maps a sanitized OpenAI function name back to its MCP upstream route.
type mcpAgentRoute struct {
	upstreamID   string
	upstreamName string
	bareTool     string
	namespaced   string
}

// mcpAgentToolset is the OpenAI tools array plus the reverse routing map.
type mcpAgentToolset struct {
	tools  []map[string]any
	routes map[string]mcpAgentRoute
}

type mcpAgentUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

func (u *mcpAgentUsage) add(o mcpAgentUsage) {
	u.PromptTokens += o.PromptTokens
	u.CompletionTokens += o.CompletionTokens
	u.TotalTokens += o.TotalTokens
}

type mcpAgentToolCall struct {
	ID   string
	Name string
	Args string
}

// mcpAgentOutcome is what the loop returns to the discovery handler for logging/response.
type mcpAgentOutcome struct {
	Content   string
	Evidences []MCPEvidence
	Usage     mcpAgentUsage
	Provider  string
	ToolCalls int
	Streamed  bool
	Err       error
}

// mcpAgenticBackingModel returns a concrete upstream model whose provider is resolvable for
// the agentic loop, or "" if none (in which case the caller uses the static path).
func (s *Server) mcpAgenticBackingModel(ctx context.Context, r *http.Request, policy MCPDiscoveryPolicy, authCtx *store.AuthContext) string {
	if configured := strings.TrimSpace(s.mcpConf().AgenticModel); configured != "" {
		if s.mcpAgenticModelResolvable(ctx, r, configured, authCtx) {
			return configured
		}
	}
	// domain_filtered / research lean on stronger reasoning; everything else can use the
	// standard tier. Reuse the auto-router's policy-aware model selection.
	tier := "standard"
	switch strings.ToLower(policy.Mode) {
	case "all_allowed", "domain_filtered":
		tier = "complex"
	}
	for _, tryTier := range []string{tier, "standard", "simple"} {
		model := s.defaultAutoModelForPolicy(tryTier, authCtx)
		if model == "" {
			continue
		}
		if s.mcpAgenticModelResolvable(ctx, r, model, authCtx) {
			return model
		}
	}
	return ""
}

func (s *Server) mcpAgenticModelResolvable(ctx context.Context, r *http.Request, model string, authCtx *store.AuthContext) bool {
	if authCtx != nil && !listAllows(model, authCtx.AllowedModels, authCtx.DeniedModels) {
		return false
	}
	provider, err := s.selectProvider(ctx, r, model)
	if err != nil {
		return false
	}
	return authCtx == nil || listAllows(provider.Name, authCtx.AllowedProviders, authCtx.DeniedProviders)
}

// buildMCPAgentToolset collects every tool advertised by the selected candidate upstreams
// and exposes them as OpenAI function definitions with sanitized, unique names.
func (s *Server) buildMCPAgentToolset(ctx context.Context, candidates []MCPCandidate) mcpAgentToolset {
	snap := s.mcpToolsSnapshotCached(ctx)
	ts := mcpAgentToolset{routes: map[string]mcpAgentRoute{}}
	usedUpstream := map[string]bool{}
	for _, c := range candidates {
		usedUpstream[c.UpstreamID] = true
	}
	seen := map[string]bool{}
	for _, tool := range snap.tools {
		route, ok := snap.routes[tool.Name]
		if !ok || !usedUpstream[route.upstreamID] {
			continue
		}
		fnName := sanitizeAgentToolName(tool.Name)
		base := fnName
		for i := 2; seen[fnName]; i++ {
			fnName = truncateText(base, 58) + "_" + fmt.Sprint(i)
		}
		seen[fnName] = true
		var params json.RawMessage = tool.InputSchema
		if len(params) == 0 || string(params) == "null" {
			params = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		desc := strings.TrimSpace(tool.Description)
		if desc == "" {
			desc = route.upstreamName + " 도구 " + route.bareTool
		}
		ts.tools = append(ts.tools, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        fnName,
				"description": desc,
				"parameters":  params,
			},
		})
		ts.routes[fnName] = mcpAgentRoute{
			upstreamID:   route.upstreamID,
			upstreamName: route.upstreamName,
			bareTool:     route.bareTool,
			namespaced:   tool.Name,
		}
	}
	return ts
}

// sanitizeAgentToolName maps an MCP namespaced tool name to a valid OpenAI function name
// (^[a-zA-Z0-9_-]{1,64}$).
func sanitizeAgentToolName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := b.String()
	if out == "" {
		out = "tool"
	}
	return truncateText(out, 64)
}

// runMCPAgenticChat runs the tool-calling loop. When streaming, it writes the OpenAI SSE
// chunks (reasoning_content for the loop narration, content for the final answer) directly
// to w and sets Streamed=true. The caller must have written all response headers (including
// Content-Type) before calling this in streaming mode.
func (s *Server) runMCPAgenticChat(w http.ResponseWriter, r *http.Request, model string, baseMessages []any, ts mcpAgentToolset, policy MCPDiscoveryPolicy, apiKeyID string, authCtx *store.AuthContext, streaming bool) mcpAgentOutcome {
	out := mcpAgentOutcome{Streamed: streaming}
	flusher, _ := w.(http.Flusher)
	streamID := "chatcmpl-" + newID("mcp")

	emitReason := func(text string) {
		if streaming {
			sseAgentChunk(w, flusher, streamID, policy.Model, map[string]any{"reasoning_content": text}, "")
		}
	}
	emitContent := func(text string) {
		if streaming {
			sseAgentChunk(w, flusher, streamID, policy.Model, map[string]any{"content": text}, "")
		}
	}

	// Prepend a grounding system directive so the model uses the tools and stays grounded.
	messages := make([]any, 0, len(baseMessages)+1)
	messages = append(messages, map[string]any{"role": "system", "content": mcpAgentSystemPrompt(policy)})
	messages = append(messages, baseMessages...)

	maxSteps := policy.MaxMCPs + 2
	if maxSteps < 3 {
		maxSteps = 3
	}
	if maxSteps > 6 {
		maxSteps = 6
	}
	emitReason(fmt.Sprintf("🧭 %d개 MCP 도구를 사용해 근거를 탐색합니다…\n", len(ts.tools)))

	for step := 0; step < maxSteps; step++ {
		body := map[string]any{
			"messages":    messages,
			"tools":       ts.tools,
			"tool_choice": "auto",
			"max_tokens":  mcpAgentMaxTokens,
		}
		raw, provider, err := s.postUpstreamChat(r.Context(), r, model, body)
		if provider != "" {
			out.Provider = provider
		}
		if err != nil {
			out.Err = err
			emitReason("⚠️ 모델 호출 실패: " + err.Error() + "\n")
			break
		}
		rawMsg, content, toolCalls, _, usage := parseAgentResponse(raw)
		out.Usage.add(usage)

		if len(toolCalls) == 0 {
			out.Content = strings.TrimSpace(content)
			break
		}

		// Echo the assistant tool-call message verbatim, then run each tool.
		if len(rawMsg) > 0 {
			messages = append(messages, rawMsg)
		}
		for _, tc := range toolCalls {
			out.ToolCalls++
			route, ok := ts.routes[tc.Name]
			argPreview := strings.TrimSpace(tc.Args)
			if argPreview == "" {
				argPreview = "{}"
			}
			emitReason("🔧 " + tc.Name + "  " + truncateText(argPreview, 240) + "\n")
			if !ok {
				messages = append(messages, map[string]any{"role": "tool", "tool_call_id": tc.ID, "content": "ERROR: unknown tool"})
				emitReason("   → 알 수 없는 도구\n")
				continue
			}
			toolContent, ev := s.execAgentToolCall(r, apiKeyID, authCtx, route, tc.Args)
			out.Evidences = append(out.Evidences, ev)
			summary := fmt.Sprintf("   → %s · %d건 · %dms", route.upstreamName, ev.SourceCount, ev.LatencyMS)
			if ev.Error != "" {
				summary = "   → 오류: " + truncateText(ev.Error, 200)
			}
			emitReason(summary + "\n")
			messages = append(messages, map[string]any{"role": "tool", "tool_call_id": tc.ID, "content": toolContent})
		}
	}

	// Loop ran out of steps while still calling tools — force a final synthesis with no tools.
	if out.Content == "" && out.Err == nil {
		body := map[string]any{
			"messages":    messages,
			"tool_choice": "none",
			"max_tokens":  mcpAgentMaxTokens,
		}
		if raw, provider, err := s.postUpstreamChat(r.Context(), r, model, body); err == nil {
			if provider != "" {
				out.Provider = provider
			}
			_, content, _, _, usage := parseAgentResponse(raw)
			out.Usage.add(usage)
			out.Content = strings.TrimSpace(content)
		} else {
			out.Err = err
		}
	}

	if streaming {
		if out.Content == "" {
			if out.Err != nil {
				out.Content = "MCP 근거 기반 응답을 생성하지 못했습니다: " + out.Err.Error()
			} else {
				out.Content = "충분한 근거를 찾지 못해 답변을 생성하지 못했습니다."
			}
		}
		// Stream the final answer in small slices for a typing effect.
		for _, slice := range chunkForTyping(out.Content, 24) {
			emitContent(slice)
		}
		sseAgentFinal(w, flusher, streamID, policy.Model, out.Usage)
	}
	return out
}

// mcpAgentSystemPrompt builds the grounding directive injected ahead of the user messages.
func mcpAgentSystemPrompt(policy MCPDiscoveryPolicy) string {
	var b strings.Builder
	b.WriteString("너는 사내 AI 게이트웨이의 근거 기반(grounded) 어시스턴트다. ")
	b.WriteString("제공된 MCP 도구를 사용해 사실과 근거를 직접 조회한 뒤, 그 결과에 기반해 한국어로 답하라. ")
	b.WriteString("필요하면 여러 도구를 순차적으로 호출해 정보를 보강하고, 충분한 근거를 모으면 명확하고 간결한 최종 답을 작성하라. ")
	b.WriteString("도구 결과에 없는 내용을 추측하지 말고, 근거가 부족하면 무엇이 부족한지 밝혀라. ")
	switch strings.ToLower(policy.Mode) {
	case "domain_filtered":
		b.WriteString("이 요청은 특정 도메인(정책/법무/컴플라이언스) 근거에 한정된다. 출처를 함께 제시하라.")
	case "all_allowed":
		b.WriteString("등록된 모든 MCP를 탐색할 수 있다. 가장 관련성 높은 도구부터 사용하라.")
	default:
		b.WriteString("질문과 가장 관련 있는 도구를 선택해 사용하라.")
	}
	return b.String()
}

// execAgentToolCall routes one model-issued tool call to its MCP upstream, enforcing
// governance, and returns the raw result text (for the model) plus an MCPEvidence record
// (for logging/learning).
func (s *Server) execAgentToolCall(r *http.Request, apiKeyID string, authCtx *store.AuthContext, route mcpAgentRoute, rawArgs string) (string, MCPEvidence) {
	ev := MCPEvidence{UpstreamID: route.upstreamID, UpstreamName: route.upstreamName, ToolName: route.bareTool}
	var args map[string]any
	if strings.TrimSpace(rawArgs) != "" {
		_ = json.Unmarshal([]byte(rawArgs), &args)
	}
	if args == nil {
		args = map[string]any{}
	}
	argsJSON, _ := json.Marshal(args)

	mroute := mcpRoute{upstreamID: route.upstreamID, upstreamName: route.upstreamName, bareTool: route.bareTool}
	if resp := s.enforceMCPToolGovernance(r, apiKeyID, authCtx, mroute, "tools/call", route.namespaced, route.bareTool, argsJSON, json.RawMessage("null")); resp != nil {
		msg := "blocked by governance"
		if resp.Error != nil {
			msg = resp.Error.Message
		}
		ev.Error = msg
		return "ERROR: " + msg, ev
	}
	up, found, err := s.db.GetMCPUpstream(r.Context(), route.upstreamID)
	if err != nil || !found || !up.Enabled {
		ev.Error = "upstream unavailable"
		return "ERROR: upstream unavailable", ev
	}
	callCtx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	start := time.Now()
	result, err := s.callUpstream(callCtx, up, "tools/call", map[string]any{"name": route.bareTool, "arguments": args})
	ev.LatencyMS = time.Since(start).Milliseconds()
	if err != nil {
		s.logMCPCall(r, apiKeyID, route.upstreamName, route.bareTool, argsJSON, true, http.StatusBadGateway, ev.LatencyMS)
		ev.Error = err.Error()
		return "ERROR: " + err.Error(), ev
	}
	items, toolErr := extractMCPResultItems(result)
	s.logMCPCall(r, apiKeyID, route.upstreamName, route.bareTool, argsJSON, toolErr != "", http.StatusOK, ev.LatencyMS)
	ev.Items = items
	ev.SourceCount = len(items)
	ev.Error = toolErr
	if len(items) > 0 {
		ev.EvidenceScore = 0.8
	}
	toolContent := strings.TrimSpace(string(result))
	if toolContent == "" {
		toolContent = "(빈 결과)"
	}
	return truncateText(toolContent, mcpAgentMaxToolResultChars), ev
}

// postUpstreamChat sends a (non-streaming) chat completion to the provider that backs
// `model`, returning the raw response bytes and provider name.
func (s *Server) postUpstreamChat(ctx context.Context, r *http.Request, model string, bodyMap map[string]any) ([]byte, string, error) {
	bodyMap["model"] = model
	bodyMap["stream"] = false
	encoded, err := json.Marshal(bodyMap)
	if err != nil {
		return nil, "", err
	}
	provider, err := s.selectProvider(ctx, r, model)
	if err != nil {
		return nil, "", err
	}
	upstreamURL, err := s.upstreamURL(provider.BaseURL, &url.URL{Path: "/v1/chat/completions"})
	if err != nil {
		return nil, provider.Name, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstreamURL, bytes.NewReader(encoded))
	if err != nil {
		return nil, provider.Name, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+provider.APIKey)
	req.Header.Set("X-Request-ID", traceIDFromRequest(r))

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, provider.Name, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return raw, provider.Name, fmt.Errorf("upstream %d: %s", resp.StatusCode, truncateText(strings.TrimSpace(string(raw)), 400))
	}
	return raw, provider.Name, nil
}

// parseAgentResponse extracts the first choice's raw message (for verbatim echo), its text
// content, any tool calls, the finish reason, and usage from a chat completion response.
func parseAgentResponse(raw []byte) (rawMsg json.RawMessage, content string, toolCalls []mcpAgentToolCall, finish string, usage mcpAgentUsage) {
	var parsed struct {
		Choices []struct {
			Message      json.RawMessage `json:"message"`
			FinishReason string          `json:"finish_reason"`
		} `json:"choices"`
		Usage mcpAgentUsage `json:"usage"`
	}
	if json.Unmarshal(raw, &parsed) != nil || len(parsed.Choices) == 0 {
		return
	}
	usage = parsed.Usage
	finish = parsed.Choices[0].FinishReason
	rawMsg = parsed.Choices[0].Message
	var m struct {
		Content   any `json:"content"`
		ToolCalls []struct {
			ID       string `json:"id"`
			Function struct {
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			} `json:"function"`
		} `json:"tool_calls"`
	}
	if json.Unmarshal(rawMsg, &m) == nil {
		content = contentString(m.Content)
		for _, tc := range m.ToolCalls {
			toolCalls = append(toolCalls, mcpAgentToolCall{ID: tc.ID, Name: tc.Function.Name, Args: tc.Function.Arguments})
		}
	}
	return
}

// sseAgentChunk writes one OpenAI streaming chunk with the given delta.
func sseAgentChunk(w io.Writer, fl http.Flusher, id, model string, delta map[string]any, finish string) {
	choice := map[string]any{"index": 0, "delta": delta}
	if finish != "" {
		choice["finish_reason"] = finish
	} else {
		choice["finish_reason"] = nil
	}
	chunk := map[string]any{
		"id": id, "object": "chat.completion.chunk", "created": time.Now().Unix(),
		"model": model, "choices": []map[string]any{choice},
	}
	b, err := json.Marshal(chunk)
	if err != nil {
		return
	}
	_, _ = io.WriteString(w, "data: "+string(b)+"\n\n")
	if fl != nil {
		fl.Flush()
	}
}

// sseAgentFinal writes the closing finish chunk, the usage chunk, and [DONE].
func sseAgentFinal(w io.Writer, fl http.Flusher, id, model string, usage mcpAgentUsage) {
	sseAgentChunk(w, fl, id, model, map[string]any{}, "stop")
	usageChunk := map[string]any{
		"id": id, "object": "chat.completion.chunk", "created": time.Now().Unix(),
		"model": model, "choices": []map[string]any{},
		"usage": map[string]any{
			"prompt_tokens": usage.PromptTokens, "completion_tokens": usage.CompletionTokens,
			"total_tokens": usage.TotalTokens,
		},
	}
	if b, err := json.Marshal(usageChunk); err == nil {
		_, _ = io.WriteString(w, "data: "+string(b)+"\n\n")
	}
	_, _ = io.WriteString(w, "data: [DONE]\n\n")
	if fl != nil {
		fl.Flush()
	}
}

// chunkForTyping splits text into UTF-8-safe slices of roughly `size` runes for a typing
// effect (the browser renders each delta progressively via requestAnimationFrame).
func chunkForTyping(text string, size int) []string {
	if size <= 0 {
		return []string{text}
	}
	runes := []rune(text)
	out := []string{}
	for i := 0; i < len(runes); i += size {
		end := i + size
		if end > len(runes) {
			end = len(runes)
		}
		out = append(out, string(runes[i:end]))
	}
	if len(out) == 0 {
		return []string{""}
	}
	return out
}

// extractChatMessagesRaw pulls the OpenAI `messages` array out of the request body as raw
// JSON elements so the full multi-turn conversation is preserved for the agentic loop.
func extractChatMessagesRaw(body []byte) []any {
	var root struct {
		Messages []json.RawMessage `json:"messages"`
	}
	if json.Unmarshal(body, &root) != nil || len(root.Messages) == 0 {
		return nil
	}
	out := make([]any, 0, len(root.Messages))
	for _, m := range root.Messages {
		out = append(out, m)
	}
	return out
}
