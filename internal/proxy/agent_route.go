package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// Agent Routes — operator-defined virtual models that run an agentic loop (LLM ↔ MCP tools) scoped
// to a pinned backing model/provider and a fixed set of MCP servers. Calling the virtual model name
// (e.g. "vibe/agent-research") transparently runs the loop and returns a normal chat completion, so
// any OpenAI-compatible client can use it just by setting `model`. This is the user-configurable
// counterpart to the built-in auto-discovery models (vibe/grounded, vibe/all-mcp, …).

// stepAgentRoute detects a request whose model matches a stored, enabled agent route and runs it
// through the agentic loop instead of the normal upstream proxy. Non-matching models pass through.
func (rc *requestPipeline) stepAgentRoute() bool {
	s, r, w := rc.s, rc.r, rc.w
	if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
		return true
	}
	if rc.body == nil {
		body, ok := rc.readRequestBody()
		if !ok {
			return false
		}
		rc.body = body
	}
	model := extractModel(rc.body)
	model = strings.TrimSpace(model)
	if model == "" {
		return true
	}
	route, ok, err := s.db.GetAgentRouteByModel(r.Context(), model)
	if err != nil || !ok || !route.Enabled {
		return true // not an agent route → continue the normal pipeline
	}
	// RBAC: honor per-key model allow/deny on the virtual model name.
	if !rc.authorizeAgentRouteModel(model) {
		return false
	}

	requestedModel := ""
	application, proceed := rc.applyModelDeprecation(model, rc.authorizeAgentRouteModel)
	if !proceed {
		return false
	}
	if application.matched {
		rc.agentRouteDeprecationModel = model
	}
	if application.rewritten {
		requestedModel = model
		model = application.replacement
		rc.agentRouteDeprecatedFrom = requestedModel
		rc.agentRouteDeprecationModel = model

		// One-hop semantics match the existing physical-model deprecation contract:
		// resolve the replacement once, but do not recursively follow another
		// deprecation (including self- and A↔B cycles).
		replacementRoute, found, lookupErr := s.db.GetAgentRouteByModel(r.Context(), model)
		if lookupErr != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "replacement model routing is unavailable", "server_error", "agent_route_lookup_failed")
			return false
		}
		if !found || !replacementRoute.Enabled {
			return true // physical/disabled replacement → continue the normal pipeline
		}
		route = replacementRoute
	}
	payload := jsonMap(rc.body)
	externalTools, _ := payload["tools"].([]any)
	externalMode := strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Agent-Mode")), "passthrough") || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Agent-Mode")), "external")
	// Frameworks such as Langflow already own the LLM -> tool -> LLM loop. Avoid
	// nesting the gateway's MCP loop inside theirs; keep this route as a pinned alias.
	if len(externalTools) > 0 || externalMode {
		backingModel := strings.TrimSpace(route.BackingModel)
		if backingModel == "" {
			backingModel = s.mcpAgenticBackingModel(r.Context(), r, MCPDiscoveryPolicy{Model: route.VirtualModel, Mode: "agent_route"}, rc.authCtx)
		}
		if backingModel == "" {
			writeOpenAIError(w, http.StatusBadGateway, "agent route has no resolvable backing model", "server_error", "agent_route_no_model")
			return false
		}
		payload["model"] = backingModel
		rewritten, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			writeOpenAIError(w, http.StatusBadRequest, "failed to rewrite agent route request", "invalid_request_error", "invalid_body")
			return false
		}
		rc.body = rewritten
		if provider := strings.TrimSpace(route.Provider); provider != "" {
			r.Header.Set("X-Proxy-Provider", provider)
			w.Header().Set("X-Agent-Provider", provider)
		}
		w.Header().Set("X-Agent-Route", route.VirtualModel)
		w.Header().Set("X-Agent-Backing-Model", backingModel)
		w.Header().Set("X-Agent-Mode", "passthrough")
		return true
	}
	rc.meta = s.handleAgentRouteChatWithRequestedModel(w, r, rc.body, route, rc.apiKeyID, rc.authCtx, requestedModel)
	rc.traceID = rc.meta.Request.TraceID
	return false
}

func (rc *requestPipeline) authorizeAgentRouteModel(model string) bool {
	if rc.authCtx == nil || listAllows(model, rc.authCtx.AllowedModels, rc.authCtx.DeniedModels) {
		return true
	}
	s, r := rc.s, rc.r
	_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{
		ID: newID("ae"), EventType: "model_denied", APIKeyID: rc.authCtx.APIKeyID,
		TeamID: rc.authCtx.TeamID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: model,
		CreatedAt: time.Now().UTC(),
	})
	writeOpenAIError(rc.w, http.StatusForbidden, "model is not allowed by auth policy", "permission_error", "model_denied")
	return false
}

// agentRouteCandidates turns a route's configured MCP upstream IDs into agent tool candidates.
// An empty MCPUpstreams list means "every registered, enabled MCP upstream".
func (s *Server) agentRouteCandidates(ctx context.Context, route store.AgentRoute) []MCPCandidate {
	want := map[string]bool{}
	for _, id := range route.MCPUpstreams {
		if id = strings.TrimSpace(id); id != "" {
			want[id] = true
		}
	}
	ups, err := s.db.ListMCPUpstreams(ctx)
	if err != nil {
		return nil
	}
	out := []MCPCandidate{}
	for _, u := range ups {
		if !u.Enabled {
			continue
		}
		if len(want) > 0 && !want[u.ID] {
			continue
		}
		out = append(out, MCPCandidate{
			UpstreamID: u.ID, UpstreamName: u.Name, FinalScore: 1, SelectorScore: 1,
			TimeoutMS: 8000, MaxResults: 5,
		})
	}
	return out
}

// filterAgentToolset narrows a toolset to an explicit tool allowlist (namespaced or bare tool
// names). Empty allowlist → unchanged (all of the servers' tools). Lets an operator expose only a
// couple of safe tools from an otherwise broad MCP server.
func filterAgentToolset(ts mcpAgentToolset, allowed []string) mcpAgentToolset {
	want := map[string]bool{}
	for _, a := range allowed {
		if a = strings.TrimSpace(a); a != "" {
			want[a] = true
		}
	}
	if len(want) == 0 {
		return ts
	}
	out := mcpAgentToolset{routes: map[string]mcpAgentRoute{}}
	for _, tool := range ts.tools {
		fn, _ := tool["function"].(map[string]any)
		if fn == nil {
			continue
		}
		fnName, _ := fn["name"].(string)
		route, ok := ts.routes[fnName]
		if !ok {
			continue
		}
		if want[route.namespaced] || want[route.bareTool] {
			out.tools = append(out.tools, tool)
			out.routes[fnName] = route
		}
	}
	return out
}

// handleAgentRouteChat runs the agentic loop for one agent-route request and writes the response
// (streaming SSE or a buffered chat completion), reusing the MCP agentic machinery.
func (s *Server) handleAgentRouteChat(w http.ResponseWriter, r *http.Request, body []byte, route store.AgentRoute, apiKeyID string, authCtx *store.AuthContext) {
	_ = s.handleAgentRouteChatWithRequestedModel(w, r, body, route, apiKeyID, authCtx, "")
}

func (s *Server) handleAgentRouteChatWithRequestedModel(w http.ResponseWriter, r *http.Request, body []byte, route store.AgentRoute, apiKeyID string, authCtx *store.AuthContext, requestedModel string) store.LogRecord {
	start := time.Now()
	traceID := traceIDFromRequest(r)
	meta := s.auditRequest(r.URL.Path, body, apiKeyID, traceID, r)
	if requestedModel = strings.TrimSpace(requestedModel); requestedModel != "" && requestedModel != meta.Request.Model {
		meta.Request.RequestedModel = requestedModel
	}
	meta.Request.ResolvedModel = route.VirtualModel
	meta.Request.Provider = firstNonEmpty(route.Provider, "agent_route")
	meta.Request.RouteReason = "agent_route"
	meta.Request.RouteDetail = route.VirtualModel

	// Pin the backing LLM to the route's provider (when set) by cloning the request with the
	// provider header so the downstream chat calls route to exactly that upstream.
	callReq := r
	if p := strings.TrimSpace(route.Provider); p != "" {
		callReq = r.Clone(r.Context())
		callReq.Header.Set("X-Proxy-Provider", p)
	}

	policy := MCPDiscoveryPolicy{
		Model: route.VirtualModel, Mode: "agent_route", Parallelism: 3, TimeoutMillis: 8000,
		SystemPrompt: route.SystemPrompt, MaxSteps: route.MaxSteps, MaxCostKRW: route.MaxCostKRW,
	}

	backingModel := strings.TrimSpace(route.BackingModel)
	if backingModel == "" {
		backingModel = s.mcpAgenticBackingModel(callReq.Context(), callReq, policy, authCtx)
	}
	if backingModel == "" {
		writeOpenAIError(w, http.StatusBadGateway, "agent route has no resolvable backing model — set one or register a provider", "server_error", "agent_route_no_model")
		return meta
	}
	meta.Request.UpstreamModel = backingModel

	candidates := s.agentRouteCandidates(r.Context(), route)
	if len(route.MCPUpstreams) > 0 && len(candidates) == 0 {
		writeOpenAIError(w, http.StatusBadGateway, "agent route has no enabled MCP upstream — review the route server selection", "server_error", "agent_route_no_mcp_upstream")
		return meta
	}
	ts := s.buildMCPAgentToolset(r.Context(), candidates)
	ts = filterAgentToolset(ts, route.AllowedTools)
	if len(route.AllowedTools) > 0 && len(ts.tools) == 0 {
		writeOpenAIError(w, http.StatusBadGateway, "agent route allowed_tools matched no currently exposed MCP tool — refresh the route tool selection", "server_error", "agent_route_no_allowed_tool")
		return meta
	}

	messages := extractChatMessagesRaw(body)
	if len(messages) == 0 {
		messages = []any{map[string]any{"role": "user", "content": ""}}
	}
	stream, _ := jsonMap(body)["stream"].(bool)
	if stream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
	}
	w.Header().Set("X-Agent-Route", route.VirtualModel)
	w.Header().Set("X-Agent-Backing-Model", backingModel)
	if route.Provider != "" {
		w.Header().Set("X-Agent-Provider", route.Provider)
	}
	w.Header().Set("X-Agent-Tools", strconv.Itoa(len(ts.tools)))

	outcome := s.runMCPAgenticChat(w, callReq, backingModel, messages, ts, policy, apiKeyID, authCtx, stream)
	if stream || (outcome.Content != "" && outcome.Err == nil) {
		usage := agenticUsageRecord(outcome, meta, len(outcome.Content))
		s.finishAgentRoute(meta, start, route, candidates, outcome, usage, apiKeyID)
		if !stream {
			w.Header().Set("X-Agent-Steps", strconv.Itoa(outcome.Steps))
			w.Header().Set("X-Agent-Tool-Calls", strconv.Itoa(outcome.ToolCalls))
			writeMCPDiscoveryCompletion(w, route.VirtualModel, outcome.Content, nil)
		}
		return meta
	}

	// The loop produced no content (e.g. backing model error). Surface it rather than hang.
	msg := "agent route produced no answer"
	if outcome.Err != nil {
		msg = "agent route failed: " + outcome.Err.Error()
	}
	writeOpenAIError(w, http.StatusBadGateway, msg, "server_error", "agent_route_failed")
	return meta
}

// finishAgentRoute enqueues the audit record for an agent-route run (response, usage, and per-tool
// invocations) — the agentic analogue of finishMCPDiscovery, minus domain-routing learning.
func (s *Server) finishAgentRoute(meta store.LogRecord, start time.Time, route store.AgentRoute, candidates []MCPCandidate, outcome mcpAgentOutcome, usage *store.TokenUsage, apiKeyID string) {
	meta.Request.StatusCode = http.StatusOK
	meta.Request.LatencyMS = time.Since(start).Milliseconds()
	meta.Request.ToolCount = outcome.ToolCalls
	meta.Request.RouteDetail = fmt.Sprintf("%s · %d tools · %d steps", route.VirtualModel, len(candidates), outcome.Steps)
	meta.Response = &store.ResponseLog{
		ID:                   newID("resp"),
		RequestID:            meta.Request.ID,
		StatusCode:           http.StatusOK,
		FinishReason:         "stop",
		ResponseHash:         audit.HashText(outcome.Content),
		ResponseTextOptional: outcome.Content,
		CreatedAt:            time.Now().UTC(),
	}
	if usage != nil {
		usage.RequestID = meta.Request.ID
		meta.Usage = usage
	}
	for _, ev := range outcome.Evidences {
		meta.Tools = append(meta.Tools, store.ToolInvocation{
			ID:          newID("tool"),
			RequestID:   meta.Request.ID,
			TraceID:     meta.Request.TraceID,
			APIKeyID:    apiKeyID,
			ServerLabel: ev.UpstreamName,
			ToolName:    ev.ToolName,
			Source:      "call",
			IsMCP:       true,
			IsError:     ev.Error != "",
			ArgHash:     audit.HashText(ev.Args),
			CreatedAt:   time.Now().UTC(),
		})
	}
	s.metrics.IncRequest(false)
	s.metrics.ObserveLatency(meta.Request.LatencyMS)
	s.metrics.ObserveToolInvocations(meta.Tools)
	s.enqueue(meta)
}
