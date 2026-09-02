package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
	"vibe-coders/internal/text2sql"
)

// handleAgentRouteTest runs the agent route once server-side with a sample prompt and returns the
// answer + loop stats, so an operator can verify a route from the admin UI without a client or key.
// The backing LLM is called with the provider's own credentials (not the caller's), so no proxy
// key is needed; RBAC is skipped because the caller is already an authorized admin.
func (s *Server) handleAgentRouteTest(w http.ResponseWriter, r *http.Request, route store.AgentRoute) {
	appProjection := r.Header.Get("X-Vibe-UI") == "app"
	var providerRef providerReferenceFunc
	if appProjection {
		providerRef = s.providerRefSnapshot()
	}
	var body struct {
		Prompt string `json:"prompt"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body)
	prompt := strings.TrimSpace(body.Prompt)
	if prompt == "" {
		prompt = "당신은 어떤 도구를 사용할 수 있나요? 하나를 골라 실제로 호출해 결과를 요약해 주세요."
	}
	reqBody, _ := json.Marshal(map[string]any{
		"model":    route.VirtualModel,
		"messages": []map[string]string{{"role": "user", "content": prompt}},
		"stream":   false,
	})
	synth := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(reqBody)).WithContext(r.Context())
	synth.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.handleAgentRouteChat(rec, synth, reqBody, route, "admin-test", nil)

	content := ""
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &parsed) == nil {
		if len(parsed.Choices) > 0 {
			content = parsed.Choices[0].Message.Content
		} else if parsed.Error != nil {
			content = parsed.Error.Message
		}
	}
	steps, _ := strconv.Atoi(rec.Header().Get("X-Agent-Steps"))
	toolCalls, _ := strconv.Atoi(rec.Header().Get("X-Agent-Tool-Calls"))
	tools, _ := strconv.Atoi(rec.Header().Get("X-Agent-Tools"))
	response := map[string]any{
		"status":        rec.Code,
		"ok":            rec.Code == http.StatusOK,
		"prompt":        prompt,
		"content":       content,
		"backing_model": rec.Header().Get("X-Agent-Backing-Model"),
		"provider":      rec.Header().Get("X-Agent-Provider"),
		"tools":         tools,
		"steps":         steps,
		"tool_calls":    toolCalls,
	}
	if appProjection && strings.TrimSpace(route.Provider) != "" {
		response["provider_ref"] = providerRef(route.Provider)
	}
	writeJSON(w, http.StatusOK, response)
}

func projectAgentRouteForApp(route store.AgentRoute, providerRef providerReferenceFunc) store.AgentRoute {
	rawProvider := route.Provider
	route.ProviderRef = ""
	if strings.TrimSpace(rawProvider) != "" {
		route.Provider = boundedModelsProviderLabel(rawProvider)
		route.ProviderRef = providerRef(rawProvider)
	}
	return route
}

func agentRouteAuditJSON(route store.AgentRoute) string {
	return auditJSON(map[string]any{
		"id": route.ID, "virtual_model": route.VirtualModel,
		"provider":      boundedModelsProviderLabel(route.Provider),
		"backing_model": route.BackingModel, "mcp": route.MCPUpstreams, "enabled": route.Enabled,
	})
}

func (s *Server) validateAgentRouteProvider(ctx context.Context, provider string, existing store.AgentRoute, existingFound bool) (string, string) {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return "", ""
	}
	// Rows created before provider-label validation may contain an unsafe or reserved
	// name. Preserve an exact unchanged binding so operators can edit unrelated route
	// fields; never permit a new route or changed binding to introduce one.
	legacyExact := existingFound && provider == strings.TrimSpace(existing.Provider) &&
		(!modelsProviderLabelSafe(provider) || modelsProviderNameReserved(provider))
	if legacyExact {
		return "", ""
	}
	if modelsProviderNameReserved(provider) {
		return "agent_route_provider_reserved", "provider name is reserved"
	}
	if !modelsProviderLabelSafe(provider) {
		return "agent_route_provider_invalid", "provider name contains unsafe metadata"
	}
	_, found, err := s.db.GetProvider(ctx, provider)
	if err != nil {
		return "agent_route_provider_lookup_failed", "provider validation is temporarily unavailable"
	}
	if !found {
		return "agent_route_provider_not_found", "provider is not configured"
	}
	return "", ""
}

// Admin CRUD for Agent Routes (operator-defined agentic virtual models).

func (s *Server) handleAgentRoutes(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		appProjection := r.Header.Get("X-Vibe-UI") == "app"
		routes, err := s.db.ListAgentRoutes(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "agent_routes_failed")
			return
		}
		if appProjection {
			providerRef := s.providerRefSnapshot()
			for index := range routes {
				routes[index] = projectAgentRouteForApp(routes[index], providerRef)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"agent_routes": routes, "count": len(routes),
			"note": "가상 모델명을 호출하면 지정한 프로바이더/백킹 모델과 지정한 MCP 서버들로 에이전틱하게 응답합니다. 클라이언트는 model 값만 이 이름으로 지정하면 됩니다.",
		})
	case http.MethodPost:
		var a store.AgentRoute
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&a); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		a.VirtualModel = strings.TrimSpace(a.VirtualModel)
		a.Provider = strings.TrimSpace(a.Provider)
		// provider_ref is output-only. Never trust or echo a client-supplied value.
		a.ProviderRef = ""
		if a.VirtualModel == "" {
			writeOpenAIError(w, http.StatusBadRequest, "virtual_model is required", "invalid_request_error", "missing_virtual_model")
			return
		}
		// Don't shadow built-in virtual models or the Text2SQL namespace.
		if isMCPDiscoveryModel(canonicalMCPDiscoveryModel(a.VirtualModel)) || text2sql.IsModel(a.VirtualModel) {
			writeOpenAIError(w, http.StatusBadRequest, "virtual_model collides with a built-in model name — choose another (e.g. vibe/agent-<name>)", "invalid_request_error", "reserved_model")
			return
		}
		var existing store.AgentRoute
		existingFound := false
		if a.ID != "" {
			var lookupErr error
			existing, existingFound, lookupErr = s.db.GetAgentRoute(r.Context(), a.ID)
			if lookupErr != nil {
				writeOpenAIError(w, http.StatusServiceUnavailable, "agent route validation is temporarily unavailable", "server_error", "agent_route_lookup_failed")
				return
			}
		}
		if a.ID == "" {
			// Keep updates keyed by the (unique) virtual model when the client omits an id.
			foundRoute, ok, lookupErr := s.db.GetAgentRouteByModel(r.Context(), a.VirtualModel)
			if lookupErr != nil {
				writeOpenAIError(w, http.StatusServiceUnavailable, "agent route validation is temporarily unavailable", "server_error", "agent_route_lookup_failed")
				return
			}
			if ok {
				existing, existingFound = foundRoute, true
				a.ID = existing.ID
				a.CreatedAt = existing.CreatedAt
			} else {
				a.ID = newID("agr")
			}
		}
		if code, message := s.validateAgentRouteProvider(r.Context(), a.Provider, existing, existingFound); code != "" {
			status := http.StatusBadRequest
			typ := "invalid_request_error"
			if code == "agent_route_provider_lookup_failed" {
				status = http.StatusServiceUnavailable
				typ = "server_error"
			}
			writeOpenAIError(w, status, message, typ, code)
			return
		}
		if a.Name == "" {
			a.Name = a.VirtualModel
		}
		if a.MaxSteps < 0 {
			a.MaxSteps = 0
		}
		if a.MaxSteps > 16 {
			a.MaxSteps = 16
		}
		if err := s.validateAgentRouteMCP(r, a); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "invalid_agent_route_tools")
			return
		}
		a.CreatedBy = adminID(r)
		if err := s.db.UpsertAgentRoute(r.Context(), a); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "agent_route_save_failed")
			return
		}
		s.auditAdmin(r, "agent_route.upsert", "", agentRouteAuditJSON(a))
		responseRoute := a
		if r.Header.Get("X-Vibe-UI") == "app" {
			responseRoute = projectAgentRouteForApp(a, s.providerRefSnapshot())
		}
		writeJSON(w, http.StatusCreated, map[string]any{"agent_route": responseRoute})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) validateAgentRouteMCP(r *http.Request, a store.AgentRoute) error {
	ups, err := s.db.ListMCPUpstreams(r.Context())
	if err != nil {
		return err
	}
	known := map[string]bool{}
	for _, up := range ups {
		if up.Enabled {
			known[up.ID] = true
		}
	}
	selected := map[string]bool{}
	for _, id := range a.MCPUpstreams {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if !known[id] {
			return errors.New("selected MCP upstream is missing or disabled: " + id)
		}
		selected[id] = true
	}
	for _, name := range a.AllowedTools {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if i := strings.Index(name, "__"); i > 0 {
			serverID := name[:i]
			if !known[serverID] {
				return errors.New("allowed tool references a missing or disabled MCP upstream: " + name)
			}
			if len(selected) > 0 && !selected[serverID] {
				return errors.New("allowed tool is outside the selected MCP upstreams: " + name)
			}
		}
	}
	return nil
}

func (s *Server) handleAgentRouteByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/agent-routes/"), "/"), "/")
	id := parts[0]
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "agent route id required", "invalid_request_error", "missing_id")
		return
	}
	if id == "tool-catalog" && r.Method == http.MethodGet {
		s.handleAgentRouteToolCatalog(w, r)
		return
	}
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}
	route, found, err := s.db.GetAgentRoute(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "agent_route_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "agent route not found", "invalid_request_error", "not_found")
		return
	}
	if action == "test" && r.Method == http.MethodPost {
		s.handleAgentRouteTest(w, r, route)
		return
	}
	switch r.Method {
	case http.MethodGet:
		if r.Header.Get("X-Vibe-UI") == "app" {
			route = projectAgentRouteForApp(route, s.providerRefSnapshot())
		}
		writeJSON(w, http.StatusOK, map[string]any{"agent_route": route})
	case http.MethodDelete:
		if err := s.db.DeleteAgentRoute(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "agent_route_delete_failed")
			return
		}
		s.auditAdmin(r, "agent_route.delete", "", auditJSON(map[string]any{"id": id, "virtual_model": route.VirtualModel}))
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "deleted": true})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleAgentRouteToolCatalog returns the live tools advertised by the selected upstreams.
// It intentionally does not use tool invocation history: the route builder must show what the
// configured servers expose now, including tools that have never been called.
func (s *Server) handleAgentRouteToolCatalog(w http.ResponseWriter, r *http.Request) {
	wanted := map[string]bool{}
	for _, id := range r.URL.Query()["upstream"] {
		if id = strings.TrimSpace(id); id != "" {
			wanted[id] = true
		}
	}
	ups, err := s.db.ListMCPUpstreams(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "agent_tool_catalog_failed")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	tools := []map[string]any{}
	errs := map[string]string{}
	for _, up := range ups {
		if !up.Enabled || (len(wanted) > 0 && !wanted[up.ID]) {
			continue
		}
		listed, listErr := s.listUpstreamTools(ctx, up)
		if listErr != nil {
			errs[up.ID] = listErr.Error()
			continue
		}
		for _, tool := range listed {
			tools = append(tools, map[string]any{
				"server_id": up.ID, "server_name": up.Name, "name": tool.Name,
				"namespaced": up.ID + "__" + tool.Name, "description": tool.Description,
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"tools": tools, "count": len(tools), "errors": errs})
}
