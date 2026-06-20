package proxy

import (
	"net/http"
	"strings"

	"vibe-coders/internal/store"
)

// flowStage is one step in a request's processing flow. status ∈
// ok | blocked | warn | fallback | skip | error. linked_artifacts holds non-sensitive
// references (ids/hashes/counts) — never raw prompt/SQL/tool args.
type flowStage struct {
	Stage     string         `json:"stage"`
	Status    string         `json:"status"`
	LatencyMS int64          `json:"latency_ms"`
	Decision  string         `json:"decision"`
	Reason    string         `json:"reason"`
	Artifacts map[string]any `json:"linked_artifacts,omitempty"`
}

// handleFlowMap reconstructs how one request flowed through the gateway (auth → quota → skill →
// governance → routing → cache → mcp → text2sql → upstream → dw) from already-stored artifacts.
// Returns metadata only (no prompt/SQL/tool-arg content). GET /admin/flow-map?request_id=
func (s *Server) handleFlowMap(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("request_id"))
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "request_id is required", "invalid_request_error", "missing_request_id")
		return
	}
	detail, err := s.db.RequestDetail(r.Context(), id)
	if err != nil || detail.Request.ID == "" {
		writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "not_found")
		return
	}
	req := detail.Request
	gov := detail.Governance
	routing, _ := s.db.RoutingDecisionByID(r.Context(), id)
	mcpRoutes, _ := s.db.MCPRouteDecisionsForRequest(r.Context(), id)

	stages := []flowStage{}

	// 1) Auth — the request was logged, so it passed key resolution unless a 401/403 was recorded.
	auth := flowStage{Stage: "auth", Status: "ok", Decision: "api_key resolved", Artifacts: map[string]any{"api_key_id": req.APIKeyID, "client_ip": req.ClientIP}}
	if req.StatusCode == http.StatusUnauthorized || req.StatusCode == http.StatusForbidden {
		auth.Status, auth.Reason = "blocked", "request rejected at auth/authorization ("+itoaProxy(req.StatusCode)+")"
	}
	stages = append(stages, auth)

	// 2) Quota / limits — inferred from a 429 or a quota/limit policy decision.
	quota := flowStage{Stage: "quota", Status: "skip", Decision: "no quota decision recorded"}
	if req.StatusCode == http.StatusTooManyRequests {
		quota.Status, quota.Reason = "blocked", "rate/quota limit hit (429)"
	} else if pd := findPolicyByKeyword(gov.PolicyDecisions, "quota", "limit", "budget"); pd != nil {
		quota.Status = decisionStatus(pd.Decision)
		quota.Decision, quota.Reason = pd.Decision, pd.Reason
	}
	stages = append(stages, quota)

	// 3) Skill — per-request skill linkage is not tracked; report as informational skip.
	stages = append(stages, flowStage{Stage: "skill", Status: "skip", Decision: "per-request skill attribution not tracked", Reason: "Skill 실행은 요청 단위로 연결되지 않습니다 (Skill Studio에서 별도 검증)"})

	// 4) Governance — policy decisions + secret events + approvals.
	govStage := flowStage{Stage: "governance", Status: "ok", Decision: "allowed", Artifacts: map[string]any{
		"policy_decisions": len(gov.PolicyDecisions), "secret_events": len(gov.SecretEvents),
		"approvals": len(gov.Approvals), "anomaly_events": len(gov.AnomalyEvents),
	}}
	if blocked := firstBlockingPolicy(gov.PolicyDecisions); blocked != nil {
		govStage.Status, govStage.Decision, govStage.Reason = "blocked", blocked.Decision, ruleLabel(blocked)
	} else if len(gov.SecretEvents) > 0 {
		govStage.Status, govStage.Reason = "warn", itoaProxy(len(gov.SecretEvents))+"건의 시크릿 탐지 이벤트"
	} else if pendingApprovals(gov.Approvals) > 0 {
		govStage.Status, govStage.Reason = "warn", itoaProxy(pendingApprovals(gov.Approvals))+"건의 승인 대기"
	}
	stages = append(stages, govStage)

	// 5) Routing — model/provider selection + fallback.
	routeStage := flowStage{Stage: "routing", Status: "skip", Decision: "no routing decision recorded"}
	if routing.ID != "" || routing.SelectedModel != "" {
		routeStage.Status = "ok"
		routeStage.Decision = strings.TrimSpace(routing.RequestedModel + " → " + routing.SelectedModel)
		routeStage.Reason = routing.DecisionReason
		routeStage.Artifacts = map[string]any{
			"requested_model": routing.RequestedModel, "selected_model": routing.SelectedModel,
			"selected_provider": routing.SelectedProvider, "health_score": routing.HealthScore,
		}
		if len(routing.FallbackPath) > 0 {
			routeStage.Status = "fallback"
			routeStage.Artifacts["fallback_path"] = strings.Join(routing.FallbackPath, " → ")
		}
	} else if req.Provider != "" {
		routeStage.Status, routeStage.Decision = "ok", "served by "+req.Provider
	}
	stages = append(stages, routeStage)

	// 6) Cache — prompt-token cache signal (semantic/chat cache is not per-request keyed).
	cache := flowStage{Stage: "cache", Status: "skip", Decision: "no per-request cache record"}
	if req.CachedTokens > 0 {
		cache.Status, cache.Decision, cache.Reason = "ok", "cached prompt tokens", itoaProxy(req.CachedTokens)+" cached tokens"
		cache.Artifacts = map[string]any{"cached_tokens": req.CachedTokens}
	}
	stages = append(stages, cache)

	// 7) MCP — tool definitions/calls/results + per-tool route decisions.
	mcp := flowStage{Stage: "mcp", Status: "skip", Decision: "no MCP tools in this request"}
	mcpTools, mcpErrors := 0, 0
	for _, t := range detail.Tools {
		if t.IsMCP {
			mcpTools++
			if t.IsError {
				mcpErrors++
			}
		}
	}
	mcpBlocked := 0
	for _, d := range mcpRoutes {
		if strings.EqualFold(d.FinalDecision, "block") || strings.EqualFold(d.FinalDecision, "deny") {
			mcpBlocked++
		}
	}
	if mcpTools > 0 || len(mcpRoutes) > 0 {
		mcp.Status, mcp.Decision = "ok", itoaProxy(mcpTools)+" MCP tool events"
		mcp.Artifacts = map[string]any{"mcp_tool_events": mcpTools, "route_decisions": len(mcpRoutes), "errors": mcpErrors, "blocked": mcpBlocked}
		if mcpBlocked > 0 {
			mcp.Status, mcp.Reason = "blocked", itoaProxy(mcpBlocked)+" tool call(s) blocked by policy"
		} else if mcpErrors > 0 {
			mcp.Status, mcp.Reason = "warn", itoaProxy(mcpErrors)+" tool call error(s)"
		}
	}
	stages = append(stages, mcp)

	// 8) Text2SQL — pipeline spans (generate/validate/execute/summarize).
	t2s := flowStage{Stage: "text2sql", Status: "skip", Decision: "not a Text2SQL request"}
	if len(detail.Text2SQLSpans) > 0 {
		var total int64
		rejected := ""
		for _, sp := range detail.Text2SQLSpans {
			total += sp.LatencyMS
			if strings.Contains(strings.ToLower(sp.Status), "reject") || strings.TrimSpace(sp.RejectReason) != "" {
				rejected = sp.Stage + ": " + sp.RejectReason
			}
		}
		t2s.Status, t2s.Decision, t2s.LatencyMS = "ok", itoaProxy(len(detail.Text2SQLSpans))+" stages", total
		t2s.Artifacts = map[string]any{"stages": len(detail.Text2SQLSpans)}
		if rejected != "" {
			t2s.Status, t2s.Reason = "blocked", rejected
		}
	}
	stages = append(stages, t2s)

	// 9) Upstream — the actual model call outcome.
	up := flowStage{Stage: "upstream", LatencyMS: req.LatencyMS, Decision: req.Provider + " · " + req.Model,
		Artifacts: map[string]any{"status_code": req.StatusCode, "first_chunk_ms": req.FirstChunkMS,
			"total_tokens": req.TotalTokens, "cost_krw": req.EstimatedCost,
			"evaluations": len(detail.Evaluations), "feedback": len(detail.Feedback)}}
	switch {
	case req.StatusCode == 0:
		up.Status, up.Reason = "warn", "no status recorded"
	case req.StatusCode >= 500:
		up.Status, up.Reason = "error", "upstream error ("+itoaProxy(req.StatusCode)+"): "+req.Error
	case req.StatusCode >= 400:
		up.Status, up.Reason = "blocked", "rejected ("+itoaProxy(req.StatusCode)+"): "+req.Error
	default:
		up.Status = "ok"
	}
	stages = append(stages, up)

	// 10) DW — whether per-request facts are being shipped to ClickHouse.
	ch := s.chConf()
	dw := flowStage{Stage: "dw", Status: "skip", Decision: "ClickHouse fact sink not configured"}
	if strings.TrimSpace(ch.URL) != "" && strings.TrimSpace(ch.RequestFactTable) != "" {
		dw.Status, dw.Decision = "ok", "request fact queued to "+ch.RequestFactTable
	}
	stages = append(stages, dw)

	writeJSON(w, http.StatusOK, map[string]any{
		"request_id": id,
		"summary": map[string]any{
			"model": req.Model, "provider": req.Provider, "status_code": req.StatusCode,
			"latency_ms": req.LatencyMS, "trace_id": req.TraceID, "created_at": req.CreatedAt,
		},
		"stages": stages,
		"note":   "각 단계는 저장된 메타데이터로 재구성됩니다(프롬프트·SQL·tool args 원문 미포함). status: ok/blocked/warn/fallback/skip/error.",
	})
}

func decisionStatus(decision string) string {
	switch strings.ToLower(strings.TrimSpace(decision)) {
	case "block", "deny", "reject":
		return "blocked"
	case "warn", "flag":
		return "warn"
	case "", "allow", "permit", "ok":
		return "ok"
	}
	return "warn"
}

func findPolicyByKeyword(pds []store.PolicyDecisionEvent, keywords ...string) *store.PolicyDecisionEvent {
	for i := range pds {
		hay := strings.ToLower(pds[i].RuleName + " " + pds[i].RuleID + " " + pds[i].Reason)
		for _, k := range keywords {
			if strings.Contains(hay, k) {
				return &pds[i]
			}
		}
	}
	return nil
}

func firstBlockingPolicy(pds []store.PolicyDecisionEvent) *store.PolicyDecisionEvent {
	for i := range pds {
		if decisionStatus(pds[i].Decision) == "blocked" {
			return &pds[i]
		}
	}
	return nil
}

func ruleLabel(pd *store.PolicyDecisionEvent) string {
	if strings.TrimSpace(pd.RuleName) != "" {
		return pd.RuleName + " — " + pd.Reason
	}
	return pd.Reason
}

func pendingApprovals(as []store.Approval) int {
	n := 0
	for _, a := range as {
		if strings.EqualFold(a.Status, "pending") {
			n++
		}
	}
	return n
}
