package proxy

import (
	"bufio"
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
	Steps     int
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

// buildMCPAgentToolset exposes the selected candidate upstreams' MCP tools as OpenAI
// function definitions, walking candidates in rank order (best FinalScore first) so that
// when the MaxTools cap is hit, the highest-ranked upstreams' tools are the ones kept.
func (s *Server) buildMCPAgentToolset(ctx context.Context, candidates []MCPCandidate) mcpAgentToolset {
	snap := s.mcpToolsSnapshotCached(ctx)
	ts := mcpAgentToolset{routes: map[string]mcpAgentRoute{}}

	// Group advertised tools by upstream so we can add them in candidate-rank order.
	toolsByUpstream := map[string][]mcpToolDef{}
	for _, tool := range snap.tools {
		if route, ok := snap.routes[tool.Name]; ok {
			toolsByUpstream[route.upstreamID] = append(toolsByUpstream[route.upstreamID], tool)
		}
	}
	maxTools := s.mcpConf().MaxTools
	if maxTools <= 0 {
		maxTools = 32
	}

	seen := map[string]bool{}
	for _, cand := range candidates {
		for _, tool := range toolsByUpstream[cand.UpstreamID] {
			if len(ts.tools) >= maxTools {
				return ts
			}
			route, ok := snap.routes[tool.Name]
			if !ok {
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

	// Step count and per-turn token budget are configurable; the loop runs at most
	// maxSteps LLM turns (each may issue several tool calls) before forcing a final answer.
	cfg := s.mcpConf()
	maxSteps := cfg.MaxAgentSteps
	if maxSteps <= 0 {
		maxSteps = 8
	}
	if maxSteps > 16 {
		maxSteps = 16
	}
	maxTokens := cfg.MaxTokens
	if maxTokens <= 0 {
		maxTokens = mcpAgentMaxTokens
	}
	// toolResultCache short-circuits identical (tool+args) calls the model repeats across
	// turns: cheaper and helps the loop converge instead of spinning on the same lookup.
	toolResultCache := map[string]string{}
	emitReason(fmt.Sprintf("🧭 %d개 MCP 도구를 사용해 근거를 탐색합니다…\n", len(ts.tools)))

	for step := 0; step < maxSteps; step++ {
		// Force at least one grounding tool call on the first turn (when enabled and tools
		// exist) so the answer is evidence-backed rather than free-form; "auto" afterwards
		// lets the model decide when it has enough to finalize.
		toolChoice := "auto"
		if step == 0 && cfg.ForceToolFirst && len(ts.tools) > 0 {
			toolChoice = "required"
		}
		body := map[string]any{
			"messages":    messages,
			"tools":       ts.tools,
			"tool_choice": toolChoice,
			"max_tokens":  maxTokens,
		}
		out.Steps++
		// In streaming mode each turn is a streaming upstream call so the final answer's
		// tokens reach the client live (real typing, not a post-hoc re-chunk); tool-calling
		// turns usually carry no content so nothing visible streams for them.
		var (
			rawMsg    json.RawMessage
			content   string
			toolCalls []mcpAgentToolCall
			finish    string
			usage     mcpAgentUsage
			provider  string
			err       error
		)
		if streaming {
			content, toolCalls, finish, usage, provider, err = s.postUpstreamChatStream(r.Context(), r, model, body, emitContent)
			if err != nil && toolChoice == "required" && !isTransientUpstreamErr(err) {
				emitReason("ℹ️ tool_choice=required 미지원 가능 — auto로 재시도합니다.\n")
				body["tool_choice"] = "auto"
				content, toolCalls, finish, usage, provider, err = s.postUpstreamChatStream(r.Context(), r, model, body, emitContent)
			}
		} else {
			var raw []byte
			raw, provider, err = s.postUpstreamChatRetry(r.Context(), r, model, body)
			// Not every provider supports tool_choice=required; on a deterministic (4xx)
			// rejection of the forced first turn, degrade gracefully to "auto".
			if err != nil && toolChoice == "required" && !isTransientUpstreamErr(err) {
				emitReason("ℹ️ tool_choice=required 미지원 가능 — auto로 재시도합니다.\n")
				body["tool_choice"] = "auto"
				raw, provider, err = s.postUpstreamChatRetry(r.Context(), r, model, body)
			}
			if err == nil {
				rawMsg, content, toolCalls, finish, usage = parseAgentResponse(raw)
			}
		}
		if provider != "" {
			out.Provider = provider
		}
		if err != nil {
			out.Err = err
			emitReason("⚠️ 모델 호출 실패: " + err.Error() + "\n")
			break
		}
		out.Usage.add(usage)

		if len(toolCalls) == 0 {
			out.Content = strings.TrimSpace(content)
			// A truncated turn (finish_reason=length) with no usable content shouldn't be
			// treated as the final answer — surface it so the cause is visible.
			if out.Content == "" && finish == "length" {
				emitReason("⚠️ 응답이 max_tokens(" + fmt.Sprint(maxTokens) + ")에서 잘렸습니다. mcp.max_tokens를 늘려보세요.\n")
			}
			break
		}
		if finish == "length" {
			emitReason("⚠️ 도구 호출이 max_tokens에서 잘렸을 수 있습니다(인자 불완전 가능). mcp.max_tokens 상향 권장.\n")
		}

		// Echo the assistant tool-call message so the conversation stays valid: tool result
		// messages MUST follow an assistant message carrying the matching tool_calls. When the
		// provider omits a usable raw message, synthesize one from the parsed tool calls.
		if len(rawMsg) > 0 {
			messages = append(messages, rawMsg)
		} else {
			messages = append(messages, synthAssistantToolCallMsg(toolCalls))
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
			cacheKey := tc.Name + "\x00" + strings.TrimSpace(tc.Args)
			if cached, hit := toolResultCache[cacheKey]; hit {
				emitReason("   → (캐시) 동일 호출 재사용\n")
				messages = append(messages, map[string]any{"role": "tool", "tool_call_id": tc.ID, "content": cached})
				continue
			}
			toolContent, ev := s.execAgentToolCall(r, apiKeyID, authCtx, route, tc.Args)
			out.Evidences = append(out.Evidences, ev)
			summary := fmt.Sprintf("   → %s · %d건 · %dms", route.upstreamName, ev.SourceCount, ev.LatencyMS)
			if ev.Error != "" {
				summary = "   → 오류: " + truncateText(ev.Error, 200)
			}
			emitReason(summary + "\n")
			toolResultCache[cacheKey] = toolContent
			messages = append(messages, map[string]any{"role": "tool", "tool_call_id": tc.ID, "content": toolContent})
		}
	}

	// Loop ran out of steps while still calling tools — force a final synthesis with no tools.
	if out.Content == "" && out.Err == nil {
		body := map[string]any{
			"messages":    messages,
			"tool_choice": "none",
			"max_tokens":  maxTokens,
		}
		if streaming {
			content, _, _, usage, provider, ferr := s.postUpstreamChatStream(r.Context(), r, model, body, emitContent)
			if ferr == nil {
				if provider != "" {
					out.Provider = provider
				}
				out.Usage.add(usage)
				out.Content = strings.TrimSpace(content)
			} else {
				out.Err = ferr
			}
		} else if raw, provider, err := s.postUpstreamChat(r.Context(), r, model, body); err == nil {
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
		// Closing summary so the loop's shape (turns/tool calls/model) is visible even
		// though those counts can't be response headers on an already-streaming response.
		emitReason(fmt.Sprintf("✅ 완료 · %d턴 · 도구호출 %d회 · 모델 %s\n", out.Steps, out.ToolCalls, firstNonEmpty(out.Provider+"/"+model, model)))
		// The answer content was already streamed live during the loop / forced synthesis;
		// only a fallback message (empty content) still needs to be emitted here.
		if out.Content == "" {
			if out.Err != nil {
				out.Content = "MCP 근거 기반 응답을 생성하지 못했습니다: " + out.Err.Error()
			} else {
				out.Content = "충분한 근거를 찾지 못해 답변을 생성하지 못했습니다."
			}
			emitContent(out.Content)
		}
		// Structured agentic stats so the debug rail can render them (the step/tool counts
		// can't be response headers on an already-streaming response).
		grounded := 0
		for _, ev := range out.Evidences {
			if ev.Error == "" && ev.SourceCount > 0 {
				grounded++
			}
		}
		stats := map[string]any{
			"steps": out.Steps, "tool_calls": out.ToolCalls,
			"evidence": grounded, "backing_model": model, "provider": out.Provider,
		}
		sseAgentFinal(w, flusher, streamID, policy.Model, out.Usage, stats)
	}
	return out
}

// synthAssistantToolCallMsg rebuilds an OpenAI assistant message carrying the given tool
// calls, used when the upstream response's raw message can't be echoed verbatim. Without a
// preceding assistant tool_calls message, the follow-up tool result messages are rejected.
func synthAssistantToolCallMsg(toolCalls []mcpAgentToolCall) map[string]any {
	calls := make([]map[string]any, 0, len(toolCalls))
	for _, tc := range toolCalls {
		args := tc.Args
		if strings.TrimSpace(args) == "" {
			args = "{}"
		}
		calls = append(calls, map[string]any{
			"id": tc.ID, "type": "function",
			"function": map[string]any{"name": tc.Name, "arguments": args},
		})
	}
	return map[string]any{"role": "assistant", "content": nil, "tool_calls": calls}
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
	ev.Args = truncateText(string(argsJSON), 600)

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

// postUpstreamChatRetry wraps postUpstreamChat with a single retry on transient failures
// (network error or 5xx), which are a common source of intermittent agentic-loop failures.
// 4xx responses (bad request, auth, rate-limit semantics) are not retried.
func (s *Server) postUpstreamChatRetry(ctx context.Context, r *http.Request, model string, bodyMap map[string]any) ([]byte, string, error) {
	raw, provider, err := s.postUpstreamChat(ctx, r, model, bodyMap)
	if err == nil || ctx.Err() != nil {
		return raw, provider, err
	}
	if !isTransientUpstreamErr(err) {
		return raw, provider, err
	}
	raw2, provider2, err2 := s.postUpstreamChat(ctx, r, model, bodyMap)
	if provider2 != "" {
		provider = provider2
	}
	return raw2, provider, err2
}

// postUpstreamChatStream sends a streaming chat completion and parses the SSE stream,
// forwarding text content deltas to onContent as they arrive (for live typing) while
// accumulating fragmented tool_calls by index. Returns the assembled message. Falls back
// to single-shot JSON parsing if the provider answers without an event stream.
func (s *Server) postUpstreamChatStream(ctx context.Context, r *http.Request, model string, bodyMap map[string]any, onContent func(string)) (content string, toolCalls []mcpAgentToolCall, finish string, usage mcpAgentUsage, provider string, err error) {
	bodyMap["model"] = model
	bodyMap["stream"] = true
	bodyMap["stream_options"] = map[string]any{"include_usage": true}
	encoded, merr := json.Marshal(bodyMap)
	if merr != nil {
		return "", nil, "", usage, "", merr
	}
	rp, perr := s.selectProvider(ctx, r, model)
	if perr != nil {
		return "", nil, "", usage, "", perr
	}
	provider = rp.Name
	upstreamURL, uerr := s.upstreamURL(rp.BaseURL, &url.URL{Path: "/v1/chat/completions"})
	if uerr != nil {
		return "", nil, "", usage, provider, uerr
	}
	req, rerr := http.NewRequestWithContext(ctx, http.MethodPost, upstreamURL, bytes.NewReader(encoded))
	if rerr != nil {
		return "", nil, "", usage, provider, rerr
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+rp.APIKey)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("X-Request-ID", traceIDFromRequest(r))
	resp, derr := s.client.Do(req)
	if derr != nil {
		return "", nil, "", usage, provider, derr
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return "", nil, "", usage, provider, fmt.Errorf("upstream %d: %s", resp.StatusCode, truncateText(strings.TrimSpace(string(raw)), 400))
	}
	// Provider ignored stream:true and returned a single JSON body — parse it as one shot.
	if !strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		_, content, toolCalls, finish, usage = parseAgentResponse(raw)
		if content != "" && onContent != nil {
			onContent(content)
		}
		return content, toolCalls, finish, usage, provider, nil
	}

	tcByIndex := map[int]*mcpAgentToolCall{}
	var order []int
	reader := bufio.NewReader(resp.Body)
	for {
		line, e := reader.ReadString('\n')
		if trimmed := strings.TrimRight(line, "\r\n"); strings.HasPrefix(trimmed, "data:") {
			data := strings.TrimSpace(trimmed[5:])
			if data == "[DONE]" {
				break
			}
			var chunk struct {
				Choices []struct {
					Delta struct {
						Content   any `json:"content"`
						ToolCalls []struct {
							Index    int    `json:"index"`
							ID       string `json:"id"`
							Function struct {
								Name      string `json:"name"`
								Arguments string `json:"arguments"`
							} `json:"function"`
						} `json:"tool_calls"`
					} `json:"delta"`
					FinishReason string `json:"finish_reason"`
				} `json:"choices"`
				Usage *mcpAgentUsage `json:"usage"`
			}
			if json.Unmarshal([]byte(data), &chunk) == nil {
				for _, ch := range chunk.Choices {
					if cs := contentString(ch.Delta.Content); cs != "" {
						content += cs
						if onContent != nil {
							onContent(cs)
						}
					}
					for _, tc := range ch.Delta.ToolCalls {
						cur := tcByIndex[tc.Index]
						if cur == nil {
							cur = &mcpAgentToolCall{}
							tcByIndex[tc.Index] = cur
							order = append(order, tc.Index)
						}
						if tc.ID != "" {
							cur.ID = tc.ID
						}
						if tc.Function.Name != "" {
							cur.Name = tc.Function.Name
						}
						cur.Args += tc.Function.Arguments
					}
					if ch.FinishReason != "" {
						finish = ch.FinishReason
					}
				}
				if chunk.Usage != nil {
					usage = *chunk.Usage
				}
			}
		}
		if e != nil {
			break
		}
	}
	for _, idx := range order {
		toolCalls = append(toolCalls, *tcByIndex[idx])
	}
	return content, toolCalls, finish, usage, provider, nil
}

// isTransientUpstreamErr reports whether an upstream error is worth one retry: transport
// errors (no status) or 5xx. The error from postUpstreamChat is formatted "upstream <code>: ..."
// for HTTP responses, so a missing "upstream 4" prefix means transport-level or 5xx.
func isTransientUpstreamErr(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	if strings.Contains(msg, "upstream 4") {
		return false // 4xx — deterministic, don't retry
	}
	return true
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

// sseAgentFinal writes the closing finish chunk, the usage chunk (carrying optional
// agentic stats under "x_mcp" for the debug rail), and [DONE].
func sseAgentFinal(w io.Writer, fl http.Flusher, id, model string, usage mcpAgentUsage, stats map[string]any) {
	sseAgentChunk(w, fl, id, model, map[string]any{}, "stop")
	usageChunk := map[string]any{
		"id": id, "object": "chat.completion.chunk", "created": time.Now().Unix(),
		"model": model, "choices": []map[string]any{},
		"usage": map[string]any{
			"prompt_tokens": usage.PromptTokens, "completion_tokens": usage.CompletionTokens,
			"total_tokens": usage.TotalTokens,
		},
	}
	if len(stats) > 0 {
		usageChunk["x_mcp"] = stats
	}
	if b, err := json.Marshal(usageChunk); err == nil {
		_, _ = io.WriteString(w, "data: "+string(b)+"\n\n")
	}
	_, _ = io.WriteString(w, "data: [DONE]\n\n")
	if fl != nil {
		fl.Flush()
	}
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
