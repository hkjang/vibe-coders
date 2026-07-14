package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"

	"vibe-coders/internal/store"
	"vibe-coders/internal/text2sql"
)

// handleAgentRouteTest runs the agent route once server-side with a sample prompt and returns the
// answer + loop stats, so an operator can verify a route from the admin UI without a client or key.
// The backing LLM is called with the provider's own credentials (not the caller's), so no proxy
// key is needed; RBAC is skipped because the caller is already an authorized admin.
func (s *Server) handleAgentRouteTest(w http.ResponseWriter, r *http.Request, route store.AgentRoute) {
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
	writeJSON(w, http.StatusOK, map[string]any{
		"status":        rec.Code,
		"ok":            rec.Code == http.StatusOK,
		"prompt":        prompt,
		"content":       content,
		"backing_model": rec.Header().Get("X-Agent-Backing-Model"),
		"provider":      rec.Header().Get("X-Agent-Provider"),
		"tools":         tools,
		"steps":         steps,
		"tool_calls":    toolCalls,
	})
}

// Admin CRUD for Agent Routes (operator-defined agentic virtual models).

func (s *Server) handleAgentRoutes(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		routes, err := s.db.ListAgentRoutes(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "agent_routes_failed")
			return
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
		if a.VirtualModel == "" {
			writeOpenAIError(w, http.StatusBadRequest, "virtual_model is required", "invalid_request_error", "missing_virtual_model")
			return
		}
		// Don't shadow built-in virtual models or the Text2SQL namespace.
		if isMCPDiscoveryModel(canonicalMCPDiscoveryModel(a.VirtualModel)) || text2sql.IsModel(a.VirtualModel) {
			writeOpenAIError(w, http.StatusBadRequest, "virtual_model collides with a built-in model name — choose another (e.g. vibe/agent-<name>)", "invalid_request_error", "reserved_model")
			return
		}
		if a.ID == "" {
			// Keep updates keyed by the (unique) virtual model when the client omits an id.
			if existing, ok, _ := s.db.GetAgentRouteByModel(r.Context(), a.VirtualModel); ok {
				a.ID = existing.ID
				a.CreatedAt = existing.CreatedAt
			} else {
				a.ID = newID("agr")
			}
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
		a.CreatedBy = adminID(r)
		if err := s.db.UpsertAgentRoute(r.Context(), a); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "agent_route_save_failed")
			return
		}
		s.auditAdmin(r, "agent_route.upsert", "", auditJSON(map[string]any{"id": a.ID, "virtual_model": a.VirtualModel, "provider": a.Provider, "backing_model": a.BackingModel, "mcp": a.MCPUpstreams, "enabled": a.Enabled}))
		writeJSON(w, http.StatusCreated, map[string]any{"agent_route": a})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
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
