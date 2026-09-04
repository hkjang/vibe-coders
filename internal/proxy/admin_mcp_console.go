package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

type mcpRouteView struct {
	Kind             string `json:"kind"`
	ExposedName      string `json:"exposed_name,omitempty"`
	URI              string `json:"uri,omitempty"`
	UpstreamID       string `json:"upstream_id"`
	UpstreamName     string `json:"upstream_name"`
	TargetMethod     string `json:"target_method"`
	TargetName       string `json:"target_name"`
	Description      string `json:"description,omitempty"`
	LastDiscoveredAt string `json:"last_discovered_at"`
	DiscoveryError   string `json:"discovery_error,omitempty"`
}

func (s *Server) handleMCPOverview(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	upstreams, err := s.db.ListMCPUpstreams(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_overview_failed")
		return
	}
	snap := s.mcpToolsSnapshotAdmin()
	summary, _ := s.db.MCPSummary(r.Context())
	tools, _ := s.db.ListMCPTools(r.Context(), store.ToolFilter{MCPOnly: true, Since: time.Now().Add(-24 * time.Hour), Limit: 500})
	recentCalls := int64(0)
	recentErrors := int64(0)
	for _, t := range tools {
		recentCalls += t.Calls
		recentErrors += t.Errors
	}
	healthy := map[string]bool{}
	for _, route := range snap.routes {
		healthy[route.upstreamID] = true
	}
	for _, route := range snap.promptRoutes {
		healthy[route.upstreamID] = true
	}
	for _, route := range snap.resourceRoutes {
		healthy[route.upstreamID] = true
	}
	enabled := 0
	for _, up := range upstreams {
		if up.Enabled {
			enabled++
		}
	}
	blockedCount := 0
	if profiles, err := s.db.ListToolRiskProfiles(r.Context()); err == nil {
		for _, p := range profiles {
			if normalizeToolRiskAction(p.Action, "") == "block" {
				blockedCount++
			}
		}
	}
	if policies, err := s.db.ListMCPPolicies(r.Context()); err == nil {
		for _, p := range policies {
			if p.Mode == "block" {
				blockedCount++
			}
		}
	}
	errorRate := 0.0
	if recentCalls > 0 {
		errorRate = float64(recentErrors) / float64(recentCalls)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"upstream_count":         len(upstreams),
		"enabled_upstream_count": enabled,
		"healthy_upstream_count": len(healthy),
		"total_tools":            len(snap.tools),
		"total_prompts":          len(snap.prompts),
		"total_resources":        len(snap.resources),
		"discovery_error_count":  len(snap.errors),
		"blocked_count":          blockedCount,
		"recent_call_count":      recentCalls,
		"recent_error_rate":      errorRate,
		"summary":                summary,
		"fetched_at":             snap.fetchedAt.UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleMCPRoutes(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	snap := s.mcpToolsSnapshotAdmin()
	writeJSON(w, http.StatusOK, map[string]any{"routes": mcpRouteViews(snap), "fetched_at": snap.fetchedAt.UTC().Format(time.RFC3339), "errors": snap.errors})
}

func (s *Server) handleMCPEffectivePolicy(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	server := strings.TrimSpace(r.URL.Query().Get("server"))
	tool := strings.TrimSpace(r.URL.Query().Get("tool"))
	if server == "" {
		writeOpenAIError(w, http.StatusBadRequest, "server is required", "invalid_request_error", "missing_server")
		return
	}
	policy, final := s.effectiveMCPPolicy(r.Context(), server, tool)
	writeJSON(w, http.StatusOK, map[string]any{"server": server, "tool": tool, "policy": policy, "final": final})
}

func (s *Server) effectiveMCPPolicy(ctx context.Context, server, tool string) (map[string]any, map[string]any) {
	policySnap := s.mcpPolicySnapshot(ctx)
	serverMode := "allow"
	decision := evaluateMCPPolicy(policySnap, []store.ToolInvocation{{IsMCP: true, ServerLabel: server, ToolName: tool}})
	if policySnap != nil {
		if mode := strings.TrimSpace(policySnap.modes[server]); mode != "" {
			serverMode = mode
		} else if policySnap.allowlist {
			serverMode = "not_in_allowlist"
		}
	}
	riskLevel, riskAction := inferMCPRisk(server, tool)
	configured := false
	note := ""
	if tool != "" {
		if profile, found, err := s.db.ToolRiskProfile(ctx, server, tool); err == nil && found {
			riskLevel = normalizeRiskLevel(profile.RiskLevel, riskLevel)
			riskAction = normalizeToolRiskAction(profile.Action, riskAction)
			configured = true
			note = profile.Note
		}
	}
	finalDecision := "allow"
	reason := "server and tool policy allow call"
	if decision.Blocked {
		finalDecision = "block"
		reason = "server policy blocked: " + decision.Reason
	} else if riskAction == "block" {
		finalDecision = "block"
		reason = firstNonEmpty(note, "tool risk profile blocks call")
	} else if riskAction == "require_approval" {
		finalDecision = "approval_required"
		reason = firstNonEmpty(note, "tool risk profile requires approval")
	} else if serverMode == "warn" || len(decision.Warnings) > 0 {
		finalDecision = "warn"
		reason = "server policy warns but allows call"
	}
	return map[string]any{
			"server_policy":        serverMode,
			"allowlist_enabled":    policySnap != nil && policySnap.allowlist,
			"tool_risk_level":      riskLevel,
			"tool_risk_action":     riskAction,
			"tool_risk_configured": configured,
			"tool_risk_note":       note,
		}, map[string]any{
			"decision": finalDecision,
			"reason":   reason,
		}
}

func (s *Server) handleMCPUpstreamFlow(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/admin/mcp/upstreams/")
	id, tail, ok := strings.Cut(path, "/")
	if !ok || tail != "flow" || strings.TrimSpace(id) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid upstream flow path", "invalid_request_error", "invalid_upstream_flow_path")
		return
	}
	up, found, err := s.db.GetMCPUpstream(r.Context(), id)
	if err != nil {
		slog.Error("MCP upstream flow lookup failed", "upstream_id", id, "error", err)
		writeOpenAIError(w, http.StatusInternalServerError, "MCP upstream flow could not be loaded", "server_error", "mcp_upstream_lookup_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "upstream not found", "invalid_request_error", "upstream_not_found")
		return
	}
	snap := s.mcpToolsSnapshotAdmin()
	routes := []mcpRouteView{}
	for _, rv := range mcpRouteViews(snap) {
		if rv.UpstreamID == up.ID {
			routes = append(routes, rv)
		}
	}
	teams, teamScoped, scopeErr := requestTeamScopeForCallerChecked(s, r)
	if scopeErr != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "MCP upstream flow scope could not be resolved", "server_error", "mcp_upstream_flow_scope_failed")
		return
	}
	tools, err := s.db.ListMCPTools(r.Context(), store.ToolFilter{
		ServerLabel: up.Name, MCPOnly: true, Since: time.Now().Add(-7 * 24 * time.Hour), Limit: 100,
		Teams: teams, TeamScoped: teamScoped,
	})
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "MCP upstream flow could not be loaded", "server_error", "mcp_upstream_flow_failed")
		return
	}
	recent, err := s.db.RequestsForToolScoped(r.Context(), up.Name, "", false, 20, teams, teamScoped)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "MCP upstream flow could not be loaded", "server_error", "mcp_upstream_flow_failed")
		return
	}
	discoveryRuns, _ := s.db.MCPDiscoveryRuns(r.Context(), up.ID, 10)
	policy, final := s.effectiveMCPPolicy(r.Context(), up.Name, "")
	response := map[string]any{
		"upstream":        up,
		"routes":          routes,
		"tool_stats":      tools,
		"recent_requests": recent,
		"discovery_runs":  discoveryRuns,
		"discovery_error": snap.errors[up.Name],
		"policy":          policy,
		"final":           final,
		"steps": []map[string]any{
			{"name": "registered", "status": "ok", "detail": up.URL},
			{"name": "enabled", "status": map[bool]string{true: "ok", false: "blocked"}[up.Enabled]},
			{"name": "discovery", "status": map[bool]string{true: "error", false: "ok"}[snap.errors[up.Name] != ""], "detail": snap.errors[up.Name]},
			{"name": "route_map", "status": map[bool]string{true: "ok", false: "warn"}[len(routes) > 0], "detail": len(routes)},
			{"name": "policy", "status": final["decision"], "detail": final["reason"]},
		},
	}
	if !s.canViewRawPrompts(r) {
		projectionArgs := s.externalCredentialProjectionArgs(up.ID, up.Name, up.URL)
		projectedUpstreams := s.projectMCPUpstreamsForExternal([]store.MCPUpstream{up})
		response["upstream"] = projectedUpstreams[0]
		projectMCPRouteViewsForExternal(routes, projectionArgs...)
		projectMCPToolStatsForExternal(tools, projectionArgs...)
		projectMCPDiscoveryRunsForExternal(discoveryRuns, projectionArgs...)
		for _, step := range response["steps"].([]map[string]any) {
			projectProviderMetadataMapForExternal(step, projectionArgs...)
		}
		projectProviderMetadataMapForExternal(policy, projectionArgs...)
		projectProviderMetadataMapForExternal(final, projectionArgs...)
		response["discovery_error"] = boundedExternalProviderText(snap.errors[up.Name], projectionArgs...)
	}
	s.maskRecentRequests(r, recent)
	writeJSON(w, http.StatusOK, response)
}

func projectMCPRouteViewsForExternal(routes []mcpRouteView, projectionArgs ...string) {
	for index := range routes {
		route := &routes[index]
		rawUpstream := route.UpstreamName
		args := append([]string{rawUpstream}, projectionArgs...)
		route.Kind = boundedExternalProviderText(route.Kind, args...)
		route.ExposedName = boundedExternalProviderText(route.ExposedName, args...)
		route.URI = boundedExternalProviderText(route.URI, args...)
		route.UpstreamID = boundedExternalProviderText(route.UpstreamID, args...)
		route.UpstreamName = boundedExternalProviderLabelOrEmpty(rawUpstream, projectionArgs...)
		route.TargetMethod = boundedExternalProviderText(route.TargetMethod, args...)
		route.TargetName = boundedExternalProviderText(route.TargetName, args...)
		route.Description = boundedExternalProviderText(route.Description, args...)
		route.LastDiscoveredAt = boundedExternalProviderText(route.LastDiscoveredAt, args...)
		route.DiscoveryError = boundedExternalProviderText(route.DiscoveryError, args...)
	}
}

func projectMCPToolStatsForExternal(tools []store.MCPToolStat, projectionArgs ...string) {
	for index := range tools {
		tool := &tools[index]
		rawServer := tool.ServerLabel
		args := append([]string{rawServer}, projectionArgs...)
		tool.ServerLabel = boundedExternalProviderLabelOrEmpty(rawServer, projectionArgs...)
		tool.ToolName = boundedExternalProviderText(tool.ToolName, args...)
		tool.SampleIP = boundedExternalIPAddress(tool.SampleIP)
		tool.LastSeen = boundedExternalProviderText(tool.LastSeen, args...)
	}
}

func projectMCPDiscoveryRunsForExternal(runs []store.MCPDiscoveryRun, projectionArgs ...string) {
	for index := range runs {
		run := &runs[index]
		rawUpstream := run.UpstreamName
		args := append([]string{rawUpstream}, projectionArgs...)
		run.ID = boundedExternalProviderText(run.ID, args...)
		run.UpstreamID = boundedExternalProviderText(run.UpstreamID, args...)
		run.UpstreamName = boundedExternalProviderLabelOrEmpty(rawUpstream, projectionArgs...)
		run.Status = boundedExternalProviderText(run.Status, args...)
		run.Error = boundedExternalProviderText(run.Error, args...)
	}
}

func (s *Server) handleMCPTopology(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	upstreams, _ := s.db.ListMCPUpstreams(r.Context())
	routes := mcpRouteViews(s.mcpToolsSnapshotAdmin())
	nodes := []map[string]any{{"id": "gateway", "label": "/mcp gateway", "kind": "gateway"}}
	edges := []map[string]any{}
	for _, up := range upstreams {
		status := "disabled"
		if up.Enabled {
			status = "enabled"
		}
		nodes = append(nodes, map[string]any{"id": "upstream:" + up.ID, "label": up.Name, "kind": "upstream", "status": status})
		edges = append(edges, map[string]any{"from": "gateway", "to": "upstream:" + up.ID, "label": "aggregates"})
	}
	for _, rv := range routes {
		id := rv.Kind + ":" + firstNonEmpty(rv.ExposedName, rv.URI)
		label := firstNonEmpty(rv.ExposedName, rv.URI)
		nodes = append(nodes, map[string]any{"id": id, "label": label, "kind": rv.Kind, "decision": s.finalDecisionForMCPRoute(r.Context(), rv.UpstreamName, rv.TargetName)})
		edges = append(edges, map[string]any{"from": "upstream:" + rv.UpstreamID, "to": id, "label": rv.TargetMethod})
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": nodes, "edges": edges})
}

func (s *Server) handleMCPRequestWaterfall(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/admin/mcp/requests/")
	id, tail, ok := strings.Cut(path, "/")
	if !ok || tail != "waterfall" || strings.TrimSpace(id) == "" || !adminTraceIdentifierValid(id) {
		writeOpenAIError(w, http.StatusBadRequest, "invalid MCP request waterfall path", "invalid_request_error", "invalid_mcp_waterfall_path")
		return
	}
	detail, err := s.db.RequestDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "request_not_found")
			return
		}
		slog.Error("MCP waterfall request lookup failed", "request_id", id, "error", err)
		writeOpenAIError(w, http.StatusInternalServerError, "MCP waterfall could not be loaded", "server_error", "mcp_waterfall_failed")
		return
	}
	if !s.canViewRequestDetail(r, detail.Request) {
		writeOpenAIError(w, http.StatusForbidden, "request is outside your team scope", "permission_error", "cross_team_access_denied")
		return
	}
	steps := s.mcpWaterfallSteps(r.Context(), detail)
	decisions, err := s.db.MCPRouteDecisionsForRequest(r.Context(), id)
	if err != nil {
		slog.Error("MCP waterfall route lookup failed", "request_id", id, "error", err)
		writeOpenAIError(w, http.StatusInternalServerError, "MCP waterfall could not be loaded", "server_error", "mcp_waterfall_failed")
		return
	}
	if !s.canViewRawPrompts(r) {
		rawIdentities := []string{detail.Request.Provider, detail.Request.FallbackFrom}
		for _, tool := range detail.Tools {
			rawIdentities = append(rawIdentities, tool.ServerLabel)
		}
		projectionArgs := s.externalCredentialProjectionArgs(rawIdentities...)
		for _, step := range steps {
			projectProviderMetadataMapForExternal(step, projectionArgs...)
		}
		projectMCPRouteDecisionsProviderForExternal(decisions, projectionArgs...)
	}
	s.maskRequestDetail(r, &detail)
	writeJSON(w, http.StatusOK, map[string]any{
		"request_id":      detail.Request.ID,
		"trace_id":        detail.Request.TraceID,
		"api_key_id":      detail.Request.APIKeyID,
		"status":          detail.Request.StatusCode,
		"latency_ms":      detail.Request.LatencyMS,
		"steps":           steps,
		"tools":           detail.Tools,
		"route_decisions": decisions,
	})
}

func (s *Server) mcpWaterfallSteps(ctx context.Context, detail store.RequestDetail) []map[string]any {
	steps := []map[string]any{
		{"name": "auth", "status": "ok", "detail": firstNonEmpty(detail.Request.APIKeyID, "admin/legacy context")},
	}
	mcpTools := []store.ToolInvocation{}
	for _, t := range detail.Tools {
		if t.IsMCP {
			mcpTools = append(mcpTools, t)
		}
	}
	if len(mcpTools) == 0 {
		steps = append(steps, map[string]any{"name": "mcp_detect", "status": "warn", "detail": "no MCP tool invocation on this request"})
		return steps
	}
	for _, t := range mcpTools {
		policy, final := s.effectiveMCPPolicy(ctx, t.ServerLabel, t.ToolName)
		routeDetail := t.ServerLabel + "/" + t.ToolName
		steps = append(steps,
			map[string]any{"name": "route_lookup", "status": "ok", "detail": routeDetail},
			map[string]any{"name": "policy_evaluation", "status": firstNonEmpty(toString(policy["server_policy"]), "allow"), "detail": policy},
			map[string]any{"name": "governance_evaluation", "status": final["decision"], "detail": final["reason"]},
			map[string]any{"name": "upstream_call", "status": map[bool]string{true: "error", false: "ok"}[t.IsError], "detail": routeDetail},
		)
	}
	logStatus := "ok"
	if detail.Request.StatusCode >= 400 {
		logStatus = "error"
	}
	steps = append(steps,
		map[string]any{"name": "response", "status": logStatus, "detail": detail.Request.StatusCode},
		map[string]any{"name": "log_enqueue", "status": "ok", "detail": len(mcpTools)},
	)
	return steps
}

func (s *Server) finalDecisionForMCPRoute(ctx context.Context, server, tool string) string {
	_, final := s.effectiveMCPPolicy(ctx, server, tool)
	if d, _ := final["decision"].(string); d != "" {
		return d
	}
	return "allow"
}

func mcpRouteViews(snap *mcpToolsSnapshot) []mcpRouteView {
	if snap == nil {
		return []mcpRouteView{}
	}
	descs := map[string]string{}
	for _, t := range snap.tools {
		descs["tool\x00"+t.Name] = t.Description
	}
	for _, p := range snap.prompts {
		descs["prompt\x00"+p.Name] = p.Description
	}
	for _, r := range snap.resources {
		descs["resource\x00"+r.URI] = r.Description
	}
	out := []mcpRouteView{}
	at := snap.fetchedAt.UTC().Format(time.RFC3339)
	for exposed, route := range snap.routes {
		out = append(out, mcpRouteView{Kind: "tool", ExposedName: exposed, UpstreamID: route.upstreamID, UpstreamName: route.upstreamName, TargetMethod: "tools/call", TargetName: route.bareTool, Description: descs["tool\x00"+exposed], LastDiscoveredAt: at, DiscoveryError: snap.errors[route.upstreamName]})
	}
	for exposed, route := range snap.promptRoutes {
		out = append(out, mcpRouteView{Kind: "prompt", ExposedName: exposed, UpstreamID: route.upstreamID, UpstreamName: route.upstreamName, TargetMethod: "prompts/get", TargetName: route.bareTool, Description: descs["prompt\x00"+exposed], LastDiscoveredAt: at, DiscoveryError: snap.errors[route.upstreamName]})
	}
	for uri, route := range snap.resourceRoutes {
		out = append(out, mcpRouteView{Kind: "resource", URI: uri, UpstreamID: route.upstreamID, UpstreamName: route.upstreamName, TargetMethod: "resources/read", TargetName: route.bareTool, Description: descs["resource\x00"+uri], LastDiscoveredAt: at, DiscoveryError: snap.errors[route.upstreamName]})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return firstNonEmpty(out[i].ExposedName, out[i].URI) < firstNonEmpty(out[j].ExposedName, out[j].URI)
	})
	return out
}

func (s *Server) handleMCPRouteExplain(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var payload struct {
		Method   string `json:"method"`
		Name     string `json:"name"`
		URI      string `json:"uri"`
		APIKeyID string `json:"api_key_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	explain := s.explainMCPRoute(r.Context(), strings.TrimSpace(payload.Method), strings.TrimSpace(payload.Name), strings.TrimSpace(payload.URI))
	writeJSON(w, http.StatusOK, explain)
}

func (s *Server) explainMCPRoute(ctx context.Context, method, name, uri string) map[string]any {
	snap := s.mcpToolsSnapshotCached(ctx)
	route, found, targetMethod, lookup := mcpLookupRoute(snap, method, name, uri)
	out := map[string]any{
		"input": map[string]any{"method": method, "name": name, "uri": uri},
		"route": map[string]any{
			"found": found,
		},
	}
	if !found {
		out["final"] = map[string]any{"decision": "block", "reason": "route not found for method/name/uri"}
		return out
	}
	out["route"] = map[string]any{
		"found":         true,
		"upstream_id":   route.upstreamID,
		"upstream_name": route.upstreamName,
		"target_method": targetMethod,
		"target_name":   route.bareTool,
		"lookup":        lookup,
	}
	policySnap := s.mcpPolicySnapshot(ctx)
	serverMode := "allow"
	policyDecision := evaluateMCPPolicy(policySnap, []store.ToolInvocation{{IsMCP: true, ServerLabel: route.upstreamName, ToolName: route.bareTool}})
	if policySnap != nil {
		if mode := strings.TrimSpace(policySnap.modes[route.upstreamName]); mode != "" {
			serverMode = mode
		} else if policySnap.allowlist {
			serverMode = "not_in_allowlist"
		}
	}
	riskLevel, riskAction := inferMCPRisk(route.upstreamName, route.bareTool)
	configured := false
	note := ""
	if profile, found, err := s.db.ToolRiskProfile(ctx, route.upstreamName, route.bareTool); err == nil && found {
		riskLevel = normalizeRiskLevel(profile.RiskLevel, riskLevel)
		riskAction = normalizeToolRiskAction(profile.Action, riskAction)
		configured = true
		note = profile.Note
	}
	finalDecision := "allow"
	reason := "route found and policy allows call"
	if policyDecision.Blocked {
		finalDecision = "block"
		reason = "server policy blocked: " + policyDecision.Reason
	} else if riskAction == "block" {
		finalDecision = "block"
		reason = firstNonEmpty(note, "tool risk profile blocks call")
	} else if riskAction == "require_approval" {
		finalDecision = "approval_required"
		reason = firstNonEmpty(note, "tool risk profile requires approval")
	} else if len(policyDecision.Warnings) > 0 || serverMode == "warn" {
		finalDecision = "warn"
		reason = "server policy warns but allows call"
	}
	out["policy"] = map[string]any{
		"server_policy":        serverMode,
		"tool_risk_level":      riskLevel,
		"tool_risk_action":     riskAction,
		"tool_risk_configured": configured,
		"tool_risk_note":       note,
	}
	out["final"] = map[string]any{"decision": finalDecision, "reason": reason}
	return out
}

func mcpLookupRoute(snap *mcpToolsSnapshot, method, name, uri string) (mcpRoute, bool, string, string) {
	if snap == nil {
		return mcpRoute{}, false, method, ""
	}
	switch method {
	case "tools/call":
		route, ok := snap.routes[name]
		return route, ok, "tools/call", name
	case "prompts/get":
		route, ok := snap.promptRoutes[name]
		return route, ok, "prompts/get", name
	case "resources/read":
		route, ok := snap.resourceRoutes[uri]
		return route, ok, "resources/read", uri
	default:
		if name != "" {
			if route, ok := snap.routes[name]; ok {
				return route, true, "tools/call", name
			}
			if route, ok := snap.promptRoutes[name]; ok {
				return route, true, "prompts/get", name
			}
		}
		if uri != "" {
			route, ok := snap.resourceRoutes[uri]
			return route, ok, "resources/read", uri
		}
	}
	return mcpRoute{}, false, method, firstNonEmpty(name, uri)
}

func (s *Server) handleMCPTest(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var payload struct {
		UpstreamID string          `json:"upstream_id"`
		Method     string          `json:"method"`
		Name       string          `json:"name"`
		URI        string          `json:"uri"`
		Arguments  json.RawMessage `json:"arguments"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	upID := strings.TrimSpace(payload.UpstreamID)
	if upID == "" {
		ex := s.explainMCPRoute(r.Context(), payload.Method, payload.Name, payload.URI)
		if route, ok := ex["route"].(map[string]any); ok {
			if id, _ := route["upstream_id"].(string); id != "" {
				upID = id
			}
		}
	}
	up, found, err := s.db.GetMCPUpstream(r.Context(), upID)
	if err != nil || !found || !up.Enabled {
		writeOpenAIError(w, http.StatusNotFound, "upstream not found or disabled", "invalid_request_error", "upstream_not_found")
		return
	}
	method := strings.TrimSpace(payload.Method)
	params := mcpTestParams(method, payload.Name, payload.URI, payload.Arguments)
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	start := time.Now()
	result, callErr := s.callUpstream(ctx, up, method, params)
	latency := time.Since(start).Milliseconds()
	out := map[string]any{
		"upstream_id":   up.ID,
		"upstream_name": up.Name,
		"method":        method,
		"latency_ms":    latency,
		"ok":            callErr == nil,
	}
	if callErr != nil {
		out["error"] = callErr.Error()
	} else {
		out["response_preview"] = truncateForPreview(string(result), 4000)
		var decoded any
		if json.Unmarshal(result, &decoded) == nil {
			out["response"] = decoded
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func mcpTestParams(method, name, uri string, args json.RawMessage) any {
	switch method {
	case "tools/call":
		return map[string]any{"name": bareMCPName(name), "arguments": rawOrEmpty(args)}
	case "prompts/get":
		return map[string]any{"name": bareMCPName(name), "arguments": rawOrEmpty(args)}
	case "resources/read":
		return map[string]any{"uri": uri}
	default:
		return map[string]any{}
	}
}

func bareMCPName(name string) string {
	if _, bare, ok := strings.Cut(name, "__"); ok {
		return bare
	}
	return name
}

func truncateForPreview(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "...(truncated)"
}
