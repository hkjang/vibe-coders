package proxy

import (
	"errors"
	"net/http"
	"strings"

	"vibe-coders/internal/store"
)

// handleMyRecentRequests lists the caller's own recent requests (safe metadata only) so they can
// open a receipt for any of them. GET /me/requests[?limit=]
func (s *Server) handleMyRecentRequests(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	items, err := s.db.UserRecentRequests(r.Context(), userID, intQuery(r, "limit", 20))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
		return
	}
	for index := range items {
		rawProvider := items[index].Provider
		items[index].Provider = boundedModelsProviderLabelOrEmpty(rawProvider)
		items[index].Model = boundedExternalProviderText(items[index].Model, rawProvider)
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": items})
}

// handleMyRequestReceipt returns a safe "receipt" for one of the caller's own requests: model,
// provider, tokens, cost, cache hit, a routing-reason summary, policy outcome, and whether a
// skill / MCP tool was used. It never exposes raw prompt, SQL, tool args, or admin-only trace.
// GET /me/requests/{id}/receipt
func (s *Server) handleMyRequestReceipt(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/me/requests/")
	idx := strings.LastIndex(rest, "/")
	if idx < 0 {
		writeOpenAIError(w, http.StatusBadRequest, "expected GET /me/requests/{id}/receipt", "invalid_request_error", "bad_request")
		return
	}
	reqID, action := rest[:idx], rest[idx+1:]
	if reqID == "" || action != "receipt" {
		writeOpenAIError(w, http.StatusBadRequest, "expected GET /me/requests/{id}/receipt", "invalid_request_error", "bad_request")
		return
	}

	// Ownership: the request's API key must belong to the caller.
	owner, err := s.db.RequestUserID(r.Context(), reqID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "lookup_failed")
		return
	}
	if owner == "" {
		writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "not_found")
		return
	}
	if owner != userID {
		writeOpenAIError(w, http.StatusForbidden, "this request does not belong to you", "invalid_request_error", "forbidden")
		return
	}

	detail, err := s.db.RequestDetail(r.Context(), reqID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "detail_failed")
		return
	}
	req := projectRecentRequestProviderForExternal(detail.Request)

	receipt := map[string]any{
		"request_id":    req.ID,
		"created_at":    req.CreatedAt,
		"endpoint":      req.Endpoint,
		"model":         req.Model,
		"provider":      req.Provider,
		"status_code":   req.StatusCode,
		"finish_reason": req.FinishReason,
		"latency_ms":    req.LatencyMS,
		"tokens": map[string]any{
			"prompt": req.PromptTokens, "completion": req.CompletionTokens,
			"total": req.TotalTokens, "cached": req.CachedTokens,
		},
		"cache_hit": req.CachedTokens > 0,
		"cost_krw":  req.EstimatedCost,
	}

	// Routing reason (if a routing decision was recorded).
	if rd, err := s.db.RoutingDecisionByID(r.Context(), reqID); err == nil {
		rd = projectRoutingDecisionProviderForExternal(rd)
		receipt["routing"] = map[string]any{
			"requested_model": rd.RequestedModel, "selected_model": rd.SelectedModel,
			"selected_provider": rd.SelectedProvider, "reason": rd.DecisionReason,
			"fallback_path": rd.FallbackPath, "risk_tier": rd.Risk.Tier, "complexity_tier": rd.Complexity.Tier,
		}
	} else if !errors.Is(err, store.ErrNotFound) {
		// Non-fatal: omit routing on any lookup error.
		_ = err
	}

	// Policy outcome — decisions only (rule + reason), no raw context.
	blocked := false
	policy := []map[string]any{}
	if events, err := s.db.PolicyDecisionEventsForRequest(r.Context(), reqID); err == nil {
		for _, e := range events {
			d := strings.ToLower(e.Decision)
			if d == "block" {
				blocked = true
			}
			if d == "allow" || d == "default" {
				continue
			}
			policy = append(policy, map[string]any{
				"decision": e.Decision,
				"rule":     e.RuleName,
				"reason":   boundedExternalProviderText(e.Reason, e.Provider),
			})
		}
	}
	receipt["blocked"] = blocked
	receipt["policy"] = policy

	// Skill / MCP usage — booleans + labels only (no args).
	mcpUsed, skillUsed := false, false
	mcpSeen, skillSeen := map[string]bool{}, map[string]bool{}
	mcpTools := []map[string]any{}
	skills := []string{}
	if tools, err := s.db.ToolsForRequest(r.Context(), reqID); err == nil {
		for _, t := range tools {
			if t.ToolName == "" {
				continue
			}
			if t.IsMCP {
				mcpUsed = true
				key := t.ServerLabel + "/" + t.ToolName
				if !mcpSeen[key] {
					mcpSeen[key] = true
					mcpTools = append(mcpTools, map[string]any{"server": boundedModelsProviderLabelOrEmpty(t.ServerLabel), "tool": t.ToolName, "error": t.IsError})
				}
			} else {
				skillUsed = true
				if !skillSeen[t.ToolName] {
					skillSeen[t.ToolName] = true
					skills = append(skills, t.ToolName)
				}
			}
		}
	}
	receipt["mcp_used"] = mcpUsed
	receipt["mcp_tools"] = mcpTools
	receipt["skill_used"] = skillUsed
	receipt["skills"] = skills

	receipt["note"] = "본인 요청의 안전 영수증입니다. 원문 prompt/SQL/tool 인자와 관리자 전용 trace는 포함되지 않습니다."
	writeJSON(w, http.StatusOK, receipt)
}
