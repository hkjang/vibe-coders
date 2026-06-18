package proxy

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

const mcpToolsTTL = 30 * time.Second

type mcpRoute struct {
	upstreamID   string
	upstreamName string
	bareTool     string
}

type mcpToolsSnapshot struct {
	tools          []mcpToolDef        // namespaced, advertised to clients
	routes         map[string]mcpRoute // namespaced tool name -> upstream route
	resources      []mcpResource       // aggregated, original URIs preserved
	resourceRoutes map[string]mcpRoute // resource uri -> upstream route (bareTool = uri)
	resourceTpls   []json.RawMessage   // aggregated resource templates (pass-through)
	prompts        []mcpPrompt         // namespaced prompt names
	promptRoutes   map[string]mcpRoute // namespaced prompt name -> upstream route
	errors         map[string]string   // upstream name -> last error (for ops visibility)
	fetchedAt      time.Time
}

// mcpToolsSnapshotCached returns the aggregated tool catalog, refreshing it past TTL.
func (s *Server) mcpToolsSnapshotCached(ctx context.Context) *mcpToolsSnapshot {
	if cached := s.mcpTools.Load(); cached != nil && time.Since(cached.fetchedAt) < mcpToolsTTL {
		return cached
	}
	snap := s.buildMCPToolsSnapshot(ctx)
	s.mcpTools.Store(snap)
	return snap
}

func (s *Server) invalidateMCPToolsCache() { s.mcpTools.Store(nil) }

func (s *Server) buildMCPToolsSnapshot(ctx context.Context) *mcpToolsSnapshot {
	snap := &mcpToolsSnapshot{
		routes: map[string]mcpRoute{}, resourceRoutes: map[string]mcpRoute{},
		promptRoutes: map[string]mcpRoute{}, errors: map[string]string{}, fetchedAt: time.Now(),
	}
	ups, err := s.db.ActiveMCPUpstreams(ctx)
	if err != nil {
		return snap
	}
	for _, up := range ups {
		route := func(bare string) mcpRoute {
			return mcpRoute{upstreamID: up.ID, upstreamName: up.Name, bareTool: bare}
		}
		// tools (the primary capability; record discovery failures here)
		lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		tools, lerr := s.listUpstreamTools(lctx, up)
		cancel()
		if lerr != nil {
			snap.errors[up.Name] = lerr.Error()
		}
		for _, t := range tools {
			namespaced := up.ID + "__" + t.Name
			adv := t
			adv.Name = namespaced
			adv.Description = prefixDesc(up.Name, adv.Description)
			snap.tools = append(snap.tools, adv)
			snap.routes[namespaced] = route(t.Name)
		}
		// resources (optional capability — silently skip upstreams that lack it)
		rctx, rcancel := context.WithTimeout(ctx, 10*time.Second)
		if resources, rerr := s.listUpstreamResources(rctx, up); rerr == nil {
			for _, res := range resources {
				if _, dup := snap.resourceRoutes[res.URI]; dup || res.URI == "" {
					continue // first upstream wins on URI collision
				}
				adv := res
				adv.Description = prefixDesc(up.Name, adv.Description)
				snap.resources = append(snap.resources, adv)
				snap.resourceRoutes[res.URI] = route(res.URI)
			}
		}
		if tpls, terr := s.listUpstreamResourceTemplates(rctx, up); terr == nil {
			snap.resourceTpls = append(snap.resourceTpls, tpls...)
		}
		rcancel()
		// prompts (optional capability)
		pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
		if prompts, perr := s.listUpstreamPrompts(pctx, up); perr == nil {
			for _, pr := range prompts {
				namespaced := up.ID + "__" + pr.Name
				adv := pr
				adv.Name = namespaced
				adv.Description = prefixDesc(up.Name, adv.Description)
				snap.prompts = append(snap.prompts, adv)
				snap.promptRoutes[namespaced] = route(pr.Name)
			}
		}
		pcancel()
	}
	sort.Slice(snap.tools, func(i, j int) bool { return snap.tools[i].Name < snap.tools[j].Name })
	sort.Slice(snap.prompts, func(i, j int) bool { return snap.prompts[i].Name < snap.prompts[j].Name })
	sort.Slice(snap.resources, func(i, j int) bool { return snap.resources[i].URI < snap.resources[j].URI })
	return snap
}

func prefixDesc(upstream, desc string) string {
	if desc != "" {
		return "[" + upstream + "] " + desc
	}
	return "[" + upstream + "]"
}

// handleMCPGateway is the JSON-RPC 2.0 MCP endpoint that aggregates upstream MCP
// servers behind a single URL: POST /mcp.
func (s *Server) handleMCPGateway(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		// Streamable HTTP clients may open a GET SSE stream; the gateway has no
		// server-initiated messages, so we simply decline it.
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
	// support a single request or a JSON-RPC batch
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "[") {
		var batch []json.RawMessage
		if err := json.Unmarshal(raw, &batch); err != nil {
			writeJSON(w, http.StatusOK, rpcErrorResponse(nil, -32700, "parse error"))
			return
		}
		var responses []any
		for _, item := range batch {
			if resp := s.dispatchMCP(w, r, apiKeyID, authCtx, item); resp != nil {
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
	resp := s.dispatchMCP(w, r, apiKeyID, authCtx, raw)
	if resp == nil { // notification: no body
		w.WriteHeader(http.StatusAccepted)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// dispatchMCP handles a single JSON-RPC message and returns the response object, or
// nil for notifications (no id).
func (s *Server) dispatchMCP(w http.ResponseWriter, r *http.Request, apiKeyID string, authCtx *store.AuthContext, raw json.RawMessage) *rpcResponse {
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
			"serverInfo": map[string]any{"name": "vibe-coders-mcp-gateway", "version": "1"},
		})
	case "notifications/initialized", "notifications/cancelled":
		return nil
	case "ping":
		return rpcResultResponse(msg.ID, map[string]any{})
	case "tools/list":
		snap := s.mcpToolsSnapshotCached(r.Context())
		tools := snap.tools
		if tools == nil {
			tools = []mcpToolDef{}
		}
		return rpcResultResponse(msg.ID, map[string]any{"tools": tools})
	case "tools/call":
		return s.mcpToolsCall(r, apiKeyID, authCtx, msg.ID, msg.Params)
	case "resources/list":
		snap := s.mcpToolsSnapshotCached(r.Context())
		res := snap.resources
		if res == nil {
			res = []mcpResource{}
		}
		return rpcResultResponse(msg.ID, map[string]any{"resources": res})
	case "resources/templates/list":
		snap := s.mcpToolsSnapshotCached(r.Context())
		tpls := snap.resourceTpls
		if tpls == nil {
			tpls = []json.RawMessage{}
		}
		return rpcResultResponse(msg.ID, map[string]any{"resourceTemplates": tpls})
	case "resources/read":
		return s.mcpResourcesRead(r, apiKeyID, authCtx, msg.ID, msg.Params)
	case "prompts/list":
		snap := s.mcpToolsSnapshotCached(r.Context())
		prompts := snap.prompts
		if prompts == nil {
			prompts = []mcpPrompt{}
		}
		return rpcResultResponse(msg.ID, map[string]any{"prompts": prompts})
	case "prompts/get":
		return s.mcpPromptsGet(r, apiKeyID, authCtx, msg.ID, msg.Params)
	default:
		if isNotification {
			return nil
		}
		return rpcErrorResponse(msg.ID, -32601, "method not found: "+msg.Method)
	}
}

func (s *Server) mcpToolsCall(r *http.Request, apiKeyID string, authCtx *store.AuthContext, id, params json.RawMessage) *rpcResponse {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(params, &p); err != nil || strings.TrimSpace(p.Name) == "" {
		return rpcErrorResponse(id, -32602, "invalid params: name is required")
	}
	snap := s.mcpToolsSnapshotCached(r.Context())
	route, found := snap.routes[p.Name]
	if !found {
		return rpcErrorResponse(id, -32602, "unknown tool: "+p.Name)
	}

	// policy: reuse the MCP allowlist/block rules keyed by server label (upstream name)
	policySnap := s.mcpPolicySnapshot(r.Context())
	decision := evaluateMCPPolicy(policySnap, []store.ToolInvocation{{IsMCP: true, ServerLabel: route.upstreamName, ToolName: route.bareTool}})
	if decision.Blocked {
		s.metrics.IncMCPBlocked()
		reqID := s.logMCPCall(r, apiKeyID, route.upstreamName, route.bareTool, p.Arguments, true, http.StatusForbidden, 0)
		s.recordMCPRouteDecision(r, reqID, apiKeyID, "tools/call", p.Name, route, "block", decision.Reason, 0)
		return rpcErrorResponse(id, -32000, "blocked by MCP policy: "+decision.Reason+" ("+decision.BlockedServer+")")
	}
	if resp := s.enforceMCPToolGovernance(r, apiKeyID, authCtx, route, "tools/call", p.Name, route.bareTool, p.Arguments, id); resp != nil {
		return resp
	}

	up, found, err := s.db.GetMCPUpstream(r.Context(), route.upstreamID)
	if err != nil || !found || !up.Enabled {
		return rpcErrorResponse(id, -32602, "upstream unavailable: "+route.upstreamName)
	}

	start := time.Now()
	callCtx, cancel := context.WithTimeout(r.Context(), s.cfg.Upstream.Timeout)
	defer cancel()
	result, callErr := s.callUpstream(callCtx, up, "tools/call", map[string]any{"name": route.bareTool, "arguments": rawOrEmpty(p.Arguments)})
	latency := time.Since(start).Milliseconds()
	if callErr != nil {
		reqID := s.logMCPCall(r, apiKeyID, route.upstreamName, route.bareTool, p.Arguments, true, http.StatusBadGateway, latency)
		s.recordMCPRouteDecision(r, reqID, apiKeyID, "tools/call", p.Name, route, "upstream_error", callErr.Error(), latency)
		return rpcErrorResponse(id, -32603, "upstream error: "+callErr.Error())
	}
	// detect tool-level error in the CallToolResult to flag it in observability
	isErr := false
	var probe struct {
		IsError bool `json:"isError"`
	}
	if json.Unmarshal(result, &probe) == nil {
		isErr = probe.IsError
	}
	reqID := s.logMCPCall(r, apiKeyID, route.upstreamName, route.bareTool, p.Arguments, isErr, http.StatusOK, latency)
	final := "allow"
	reason := "upstream call completed"
	if isErr {
		final = "tool_error"
		reason = "tool result isError=true"
	}
	s.recordMCPRouteDecision(r, reqID, apiKeyID, "tools/call", p.Name, route, final, reason, latency)
	return &rpcResponse{JSONRPC: "2.0", ID: id, Result: result}
}

// mcpResourcesRead routes a resources/read to the upstream that advertised the URI.
func (s *Server) mcpResourcesRead(r *http.Request, apiKeyID string, authCtx *store.AuthContext, id, params json.RawMessage) *rpcResponse {
	var p struct {
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(params, &p); err != nil || strings.TrimSpace(p.URI) == "" {
		return rpcErrorResponse(id, -32602, "invalid params: uri is required")
	}
	snap := s.mcpToolsSnapshotCached(r.Context())
	route, found := snap.resourceRoutes[p.URI]
	if !found {
		return rpcErrorResponse(id, -32602, "unknown resource: "+p.URI)
	}
	return s.routeUpstreamRPC(r, apiKeyID, authCtx, id, route, "resources/read", p.URI, "resources/read", map[string]any{"uri": p.URI}, params)
}

// mcpPromptsGet routes a prompts/get to the owning upstream using the namespaced name.
func (s *Server) mcpPromptsGet(r *http.Request, apiKeyID string, authCtx *store.AuthContext, id, params json.RawMessage) *rpcResponse {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(params, &p); err != nil || strings.TrimSpace(p.Name) == "" {
		return rpcErrorResponse(id, -32602, "invalid params: name is required")
	}
	snap := s.mcpToolsSnapshotCached(r.Context())
	route, found := snap.promptRoutes[p.Name]
	if !found {
		return rpcErrorResponse(id, -32602, "unknown prompt: "+p.Name)
	}
	return s.routeUpstreamRPC(r, apiKeyID, authCtx, id, route, "prompts/get", p.Name, route.bareTool, map[string]any{"name": route.bareTool, "arguments": rawOrEmpty(p.Arguments)}, params)
}

// routeUpstreamRPC enforces policy, forwards a (non tools/call) MCP method to the
// owning upstream, and logs it into the unified observability pipeline. logLabel is
// the tool_name recorded for the call.
func (s *Server) routeUpstreamRPC(r *http.Request, apiKeyID string, authCtx *store.AuthContext, id json.RawMessage, route mcpRoute, method, exposedName, logLabel string, params map[string]any, rawParams json.RawMessage) *rpcResponse {
	policySnap := s.mcpPolicySnapshot(r.Context())
	decision := evaluateMCPPolicy(policySnap, []store.ToolInvocation{{IsMCP: true, ServerLabel: route.upstreamName, ToolName: logLabel}})
	if decision.Blocked {
		s.metrics.IncMCPBlocked()
		reqID := s.logMCPCall(r, apiKeyID, route.upstreamName, logLabel, rawParams, true, http.StatusForbidden, 0)
		s.recordMCPRouteDecision(r, reqID, apiKeyID, method, exposedName, route, "block", decision.Reason, 0)
		return rpcErrorResponse(id, -32000, "blocked by MCP policy: "+route.upstreamName)
	}
	if resp := s.enforceMCPToolGovernance(r, apiKeyID, authCtx, route, method, exposedName, logLabel, rawParams, id); resp != nil {
		return resp
	}
	up, found, err := s.db.GetMCPUpstream(r.Context(), route.upstreamID)
	if err != nil || !found || !up.Enabled {
		return rpcErrorResponse(id, -32602, "upstream unavailable: "+route.upstreamName)
	}
	start := time.Now()
	callCtx, cancel := context.WithTimeout(r.Context(), s.cfg.Upstream.Timeout)
	defer cancel()
	result, callErr := s.callUpstream(callCtx, up, method, params)
	latency := time.Since(start).Milliseconds()
	if callErr != nil {
		reqID := s.logMCPCall(r, apiKeyID, route.upstreamName, logLabel, rawParams, true, http.StatusBadGateway, latency)
		s.recordMCPRouteDecision(r, reqID, apiKeyID, method, exposedName, route, "upstream_error", callErr.Error(), latency)
		return rpcErrorResponse(id, -32603, "upstream error: "+callErr.Error())
	}
	reqID := s.logMCPCall(r, apiKeyID, route.upstreamName, logLabel, rawParams, false, http.StatusOK, latency)
	s.recordMCPRouteDecision(r, reqID, apiKeyID, method, exposedName, route, "allow", "upstream call completed", latency)
	return &rpcResponse{JSONRPC: "2.0", ID: id, Result: result}
}

func (s *Server) recordMCPRouteDecision(r *http.Request, requestID, apiKeyID, method, exposedName string, route mcpRoute, finalDecision, reason string, latency int64) {
	if requestID == "" {
		return
	}
	policy, final := s.effectiveMCPPolicy(r.Context(), route.upstreamName, route.bareTool)
	if finalDecision == "" {
		finalDecision, _ = final["decision"].(string)
	}
	if reason == "" {
		reason, _ = final["reason"].(string)
	}
	decision := store.MCPRouteDecision{
		ID:             newID("mrd"),
		RequestID:      requestID,
		TraceID:        traceIDFromRequest(r),
		APIKeyID:       apiKeyID,
		Method:         method,
		ExposedName:    exposedName,
		UpstreamID:     route.upstreamID,
		UpstreamName:   route.upstreamName,
		TargetName:     route.bareTool,
		ServerPolicy:   toString(policy["server_policy"]),
		ToolRiskLevel:  toString(policy["tool_risk_level"]),
		ToolRiskAction: toString(policy["tool_risk_action"]),
		FinalDecision:  finalDecision,
		Reason:         reason,
		LatencyMS:      latency,
		CreatedAt:      time.Now().UTC(),
	}
	if decision.TraceID == "" {
		decision.TraceID = requestID
	}
	if err := s.db.InsertMCPRouteDecision(r.Context(), decision); err != nil {
		slog.Warn("insert MCP route decision failed", "request_id", requestID, "error", err)
	}
}

// logMCPCall records a gateway MCP call into the same tool_invocations pipeline as
// chat-embedded tool calls, so all MCP observability (servers, loops, catalog,
// policy) and user attribution include protocol-level calls.
func (s *Server) logMCPCall(r *http.Request, apiKeyID, serverName, toolName string, args json.RawMessage, isErr bool, status int, latency int64) string {
	now := time.Now().UTC()
	reqID := newID("req")
	traceID := traceIDFromRequest(r)
	if traceID == "" {
		traceID = reqID
	}
	sessionID := ""
	if s.cfg.Session.InferenceEnabled && s.sessions != nil {
		sessionID = s.inferSessionID(r, apiKeyID, now)
	}
	argStr := strings.TrimSpace(string(args))
	tool := store.ToolInvocation{
		ID:           newID("tool"),
		RequestID:    reqID,
		TraceID:      traceID,
		APIKeyID:     apiKeyID,
		ServerLabel:  serverName,
		ToolName:     toolName,
		Source:       "call",
		IsMCP:        true,
		IsError:      isErr,
		ArgSensitive: argStr != "" && audit.Contains(argStr),
		ArgHash:      audit.HashText(argStr),
		CreatedAt:    now,
	}
	record := store.LogRecord{
		Request: store.RequestLog{
			ID: reqID, TraceID: traceID, APIKeyID: apiKeyID,
			ClientIP: clientIP(r), UserAgent: r.UserAgent(), Hostname: hostname(),
			Model: "mcp:" + serverName, Endpoint: "/mcp", Provider: serverName,
			StatusCode: status, ToolCount: 1, SessionID: sessionID, CreatedAt: now,
		},
		Tools: []store.ToolInvocation{tool},
	}
	if isErr {
		record.Request.Error = "tool_error"
	}
	s.metrics.ObserveToolInvocations(record.Tools)
	s.enqueue(record)
	return reqID
}

func rawOrEmpty(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	return raw
}

func rpcResultResponse(id json.RawMessage, result any) *rpcResponse {
	b, _ := json.Marshal(result)
	return &rpcResponse{JSONRPC: "2.0", ID: idOrNull(id), Result: b}
}

func rpcErrorResponse(id json.RawMessage, code int, message string) *rpcResponse {
	return &rpcResponse{JSONRPC: "2.0", ID: idOrNull(id), Error: &rpcError{Code: code, Message: message}}
}

func idOrNull(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}
