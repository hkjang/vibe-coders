package proxy

import (
	"net/http"
	"sort"
	"strings"

	"vibe-coders/internal/store"
)

// handleMCPAgenticRuns reconstructs the MCP agentic discovery loop for one request: candidate
// tools + selector/evidence scores, tool calls + results, and the evidence-gate / synthesis
// outcome. Built from stored domain-routing decisions/signals + tool invocations (no tool-arg
// content — arg hashes only). GET /admin/mcp/agentic-runs?request_id=
func (s *Server) handleMCPAgenticRuns(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("request_id"))
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "request_id is required", "invalid_request_error", "missing_request_id")
		return
	}
	decisions, err := s.db.ListDomainRoutingDecisions(r.Context(), store.DomainRoutingFilter{RequestID: id, Limit: 1})
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "agentic_failed")
		return
	}
	tools, _ := s.db.ToolsForRequest(r.Context(), id)
	mcpRoutes, _ := s.db.MCPRouteDecisionsForRequest(r.Context(), id)

	if len(decisions) == 0 && len(tools) == 0 && len(mcpRoutes) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"request_id": id, "agentic": false,
			"note": "이 요청에 대한 MCP agentic discovery 기록이 없습니다(일반 chat이거나 도구 미사용).",
		})
		return
	}

	resp := map[string]any{"request_id": id, "agentic": true}

	if len(decisions) > 0 {
		d := decisions[0]
		signals, _ := s.db.DomainRoutingSignals(r.Context(), d.ID)
		// Group signals by source for the timeline.
		candidates := []map[string]any{}
		evidences := []map[string]any{}
		gate := map[string]any(nil)
		explicit := ""
		for _, sig := range signals {
			switch sig.Source {
			case "selector":
				candidates = append(candidates, map[string]any{"tool": sig.Reason, "score": round1(sig.Score * 100)})
			case "mcp_evidence":
				ev := map[string]any{"tool": sig.Reason, "score": round1(sig.Score * 100)}
				if strings.Contains(sig.Reason, "error=") {
					ev["error"] = true
				}
				evidences = append(evidences, ev)
			case "evidence_gate":
				gate = map[string]any{"passed": false, "reason": sig.Reason}
			case "explicit_model":
				explicit = sig.Reason
			}
		}
		sort.Slice(candidates, func(i, j int) bool {
			return candidates[i]["score"].(float64) > candidates[j]["score"].(float64)
		})
		if gate == nil {
			gate = map[string]any{"passed": d.EvidenceCount > 0, "reason": "evidence_count=" + itoaProxy(d.EvidenceCount)}
		}
		resp["decision"] = map[string]any{
			"route": d.Route, "confidence": round1(d.Confidence * 100), "evidence_score": round1(d.EvidenceScore * 100),
			"evidence_count": d.EvidenceCount, "fallback_used": d.FallbackUsed, "blocked_by_governance": d.BlockedByGovernance,
			"reason": d.Reason, "candidates_selected": d.ToolNames, "explicit_model": explicit, "created_at": d.CreatedAt,
		}
		resp["candidate_scores"] = candidates
		resp["evidence_scores"] = evidences
		resp["evidence_gate"] = gate
	}

	// Tool calls/results executed during the loop (MCP only), arg hash only.
	toolEvents := []map[string]any{}
	for _, t := range tools {
		if !t.IsMCP {
			continue
		}
		toolEvents = append(toolEvents, map[string]any{
			"server": t.ServerLabel, "tool": t.ToolName, "source": t.Source,
			"is_error": t.IsError, "arg_hash": t.ArgHash, "arg_sensitive": t.ArgSensitive, "created_at": t.CreatedAt,
		})
	}
	resp["tool_events"] = toolEvents

	// Per-tool route/risk decisions (policy, risk level/action, final decision).
	routeDecisions := []map[string]any{}
	for _, d := range mcpRoutes {
		routeDecisions = append(routeDecisions, map[string]any{
			"exposed_name": d.ExposedName, "upstream": d.UpstreamName, "target": d.TargetName,
			"server_policy": d.ServerPolicy, "risk_level": d.ToolRiskLevel, "risk_action": d.ToolRiskAction,
			"final_decision": d.FinalDecision, "reason": d.Reason, "latency_ms": d.LatencyMS,
		})
	}
	resp["route_decisions"] = routeDecisions
	resp["note"] = "후보 점수·증거·tool 호출은 저장된 라우팅 결정/시그널 기준입니다. tool arguments 원문은 저장하지 않고 hash만 노출합니다. 원시 selector relevance·stopping reason 등 일부 신호는 현재 미적재."

	writeJSON(w, http.StatusOK, resp)
}
