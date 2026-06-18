package proxy

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// handleRequestExplain assembles the Explainability View (XView) for one request:
// why it was routed where it was, whether it failed over, cache savings, safety
// findings, cost breakdown, and a link to the session flow.
func (s *Server) handleRequestExplain(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	// path: /admin/requests/{id}/explain
	rest := strings.TrimPrefix(r.URL.Path, "/admin/requests/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 || parts[1] != "explain" {
		writeOpenAIError(w, http.StatusNotFound, "not found", "invalid_request_error", "not_found")
		return
	}
	id := parts[0]

	d, err := s.db.ExplainRow(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "request_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "explain_failed")
		return
	}
	evals, err := s.db.EvaluationsForRequest(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "explain_failed")
		return
	}
	governance, err := s.governanceEventsForRequest(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "explain_failed")
		return
	}
	text2sqlSpans, err := s.db.Text2SQLSpansForRequest(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "explain_failed")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"request_id": d.RequestID,
		"trace_id":   d.TraceID,
		"created_at": d.CreatedAt,
		"routing":    s.explainRouting(d),
		"fallback":   explainFallback(d),
		"cache":      s.explainCache(d),
		"safety":     explainSafety(d, evals, governance),
		"governance": explainGovernance(governance),
		"text2sql":   explainText2SQL(text2sqlSpans),
		"cost":       s.explainCost(d),
		"session":    map[string]any{"session_id": d.SessionID, "stream": d.Stream},
	})
}

func explainText2SQL(spans []store.Text2SQLSpan) map[string]any {
	totalLatency := int64(0)
	totalCost := 0.0
	status := "none"
	for _, sp := range spans {
		totalLatency += sp.LatencyMS
		totalCost += sp.CostKRW
		if sp.Status == "error" {
			status = "error"
		} else if status == "none" && sp.Status != "" {
			status = "ok"
		}
	}
	return map[string]any{
		"spans":            spans,
		"span_count":       len(spans),
		"status":           status,
		"total_latency_ms": totalLatency,
		"total_cost_krw":   totalCost,
	}
}

func tierForComplexity(c int) string {
	return complexityTierName(c)
}

func (s *Server) explainRouting(d store.ExplainData) map[string]any {
	reasonText := map[string]string{
		"header":          "클라이언트가 X-Proxy-Provider 헤더로 명시 지정",
		"query":           "요청 쿼리(?provider=)로 명시 지정",
		"model_pattern":   "모델 패턴 자동 라우팅",
		"default":         "기본 provider(UPSTREAM_PROVIDER)",
		"complexity_rule": "복잡도 기반 비용 최적 라우팅 규칙",
		"auto_router":     "Intelligent Routing Engine 자동 모델 선택",
		"rule_provider":   "라우팅 규칙이 지정한 provider",
		"cache":           "응답 캐시 히트",
	}[d.RouteReason]
	if reasonText == "" {
		reasonText = d.RouteReason
	}
	out := map[string]any{
		"chosen_provider": d.Provider,
		"chosen_model":    d.Model,
		"reason":          d.RouteReason,
		"reason_text":     reasonText,
		"detail":          d.RouteDetail,
		"complexity":      d.Complexity,
		"tier":            firstNonEmpty(d.ComplexityTier, tierForComplexity(d.Complexity)),
		"risk_score":      d.RiskScore,
		"risk_tier":       d.RiskTier,
		"risk_categories": d.RiskCategories,
		"health_score":    d.HealthScore,
		"decision_reason": d.RoutingReason,
		"fallback_path":   d.RoutingFallbackPath,
		"endpoint":        d.Endpoint,
	}
	// surface model downgrade/upgrade when a complexity rule changed the model
	if d.RequestedModel != "" && d.RequestedModel != d.Model {
		out["requested_model"] = d.RequestedModel
		out["model_changed"] = true
	}
	return out
}

func explainFallback(d store.ExplainData) map[string]any {
	out := map[string]any{"occurred": d.Failover}
	if d.Failover {
		out["from_provider"] = d.FallbackFrom
		out["to_provider"] = d.Provider
		out["reason"] = "기본 provider 전송 실패로 대체 provider 사용"
	}
	if d.FallbackReason != "" {
		out["error"] = d.FallbackReason
	}
	return out
}

func (s *Server) explainCache(d store.ExplainData) map[string]any {
	out := map[string]any{
		"hit":           d.TokenSource == "cache",
		"cached_tokens": d.CachedTokens,
	}
	price, hasPrice := lookupModelPrice(d.Model, s.cfg.Pricing)
	// Full cache hit (embedding cache): we charged 0; savings = what it would have cost.
	if d.TokenSource == "cache" && hasPrice {
		out["savings_krw"] = float64(d.PromptTokens) * price.InputKRWPer1M / 1_000_000
	}
	// Prompt-cached tokens: savings = cached_tokens * (input - cached_input) per 1M.
	if d.CachedTokens > 0 && hasPrice {
		cachedRate := price.CachedInputKRWPer1M
		if cachedRate <= 0 {
			cachedRate = price.InputKRWPer1M
		}
		out["cached_savings_krw"] = float64(d.CachedTokens) * (price.InputKRWPer1M - cachedRate) / 1_000_000
	}
	return out
}

func explainSafety(d store.ExplainData, evals []store.LLMEvaluation, governance store.GovernanceEvents) map[string]any {
	findings := []map[string]any{}
	blocked := false
	for _, e := range evals {
		if e.Category != "safety" && e.Category != "security" && !strings.HasPrefix(e.Name, "tools.") {
			continue
		}
		if e.Passed {
			continue
		}
		findings = append(findings, map[string]any{
			"name": e.Name, "label": e.Label, "reason": e.Reason, "category": e.Category,
		})
	}
	for _, event := range governance.SecretEvents {
		findings = append(findings, map[string]any{
			"name":     "secret_firewall." + event.SecretType,
			"label":    event.Action,
			"reason":   "secret firewall " + event.Action,
			"category": "security",
		})
		if event.Action == "block" {
			blocked = true
		}
	}
	for _, approval := range governance.Approvals {
		if approval.Status == "pending" || approval.Status == "rejected" || approval.Status == "expired" {
			findings = append(findings, map[string]any{
				"name":     "governance.approval",
				"label":    approval.Status,
				"reason":   approval.Reason,
				"category": "governance",
			})
			if approval.Status != "approved" {
				blocked = true
			}
		}
	}
	for _, event := range governance.PolicyDecisions {
		if event.Decision == "allow" || event.Decision == "detect" {
			continue
		}
		findings = append(findings, map[string]any{
			"name":     "policy." + firstNonEmpty(event.RuleName, event.RuleID, event.PolicyID),
			"label":    event.Decision,
			"reason":   event.Reason,
			"category": "governance",
		})
		if event.Decision == "block" || strings.HasPrefix(event.Decision, "deny_") {
			blocked = true
		}
	}
	if d.StatusCode == http.StatusForbidden || d.Provider == "blocked" {
		blocked = true
	}
	return map[string]any{
		"blocked":       blocked,
		"masking":       "프롬프트/응답에 마스킹 규칙 적용 (PII·시크릿·카드·주민번호 등)",
		"findings":      findings,
		"finding_count": len(findings),
	}
}

func (s *Server) governanceEventsForRequest(ctx context.Context, requestID string) (store.GovernanceEvents, error) {
	var out store.GovernanceEvents
	var err error
	if _, err = s.db.ExpireApprovals(ctx, time.Now().UTC()); err != nil {
		return out, err
	}
	if out.SecretEvents, err = s.db.SecretEventsForRequest(ctx, requestID); err != nil {
		return out, err
	}
	if out.Approvals, err = s.db.ApprovalsForRequest(ctx, requestID); err != nil {
		return out, err
	}
	if out.AnomalyEvents, err = s.db.AnomalyEventsForRequest(ctx, requestID, 1*time.Hour); err != nil {
		return out, err
	}
	if out.PolicyDecisions, err = s.db.PolicyDecisionEventsForRequest(ctx, requestID); err != nil {
		return out, err
	}
	return out, nil
}

func explainGovernance(events store.GovernanceEvents) map[string]any {
	approvalStatus := ""
	for _, approval := range events.Approvals {
		if approvalStatus == "" || approval.Status == "pending" || approval.Status == "rejected" {
			approvalStatus = approval.Status
		}
	}
	secretActions := map[string]int{}
	for _, event := range events.SecretEvents {
		secretActions[event.Action]++
	}
	effectivePolicyDecisions := effectivePolicyDecisionCount(events.PolicyDecisions)
	return map[string]any{
		"secret_events":         events.SecretEvents,
		"secret_event_count":    len(events.SecretEvents),
		"secret_actions":        secretActions,
		"approvals":             events.Approvals,
		"approval_count":        len(events.Approvals),
		"approval_status":       approvalStatus,
		"anomaly_events":        events.AnomalyEvents,
		"anomaly_event_count":   len(events.AnomalyEvents),
		"policy_decisions":      events.PolicyDecisions,
		"policy_decision_count": effectivePolicyDecisions,
		"policy_decision_total": len(events.PolicyDecisions),
	}
}

func effectivePolicyDecisionCount(events []store.PolicyDecisionEvent) int {
	count := 0
	for _, event := range events {
		if !strings.EqualFold(strings.TrimSpace(event.Decision), "default") {
			count++
		}
	}
	return count
}

func (s *Server) explainCost(d store.ExplainData) map[string]any {
	out := map[string]any{
		"actual_krw":        d.EstimatedCost,
		"currency":          "KRW",
		"token_source":      d.TokenSource,
		"prompt_tokens":     d.PromptTokens,
		"completion_tokens": d.CompletionTokens,
		"cached_tokens":     d.CachedTokens,
		"reasoning_tokens":  d.ReasoningTokens,
		"total_tokens":      d.TotalTokens,
	}
	// "list price" had nothing been cached: charge all prompt tokens at full input rate.
	if price, ok := lookupModelPrice(d.Model, s.cfg.Pricing); ok {
		full := float64(d.PromptTokens)*price.InputKRWPer1M/1_000_000 +
			float64(d.CompletionTokens+d.ReasoningTokens)*price.OutputKRWPer1M/1_000_000
		out["list_krw"] = full
		if full > d.EstimatedCost {
			out["savings_krw"] = full - d.EstimatedCost
		}
		out["priced"] = true
	} else {
		out["priced"] = false
	}
	return out
}

// lookupModelPrice mirrors audit.lookupPrice (prefix match) for explain savings math.
func lookupModelPrice(model string, pricing map[string]config.ModelPrice) (config.ModelPrice, bool) {
	normalized := strings.ToLower(strings.TrimSpace(model))
	if normalized == "" {
		return config.ModelPrice{}, false
	}
	if p, ok := pricing[normalized]; ok {
		return p, true
	}
	for key, p := range pricing {
		key = strings.ToLower(strings.TrimSpace(key))
		if key != "" && strings.HasPrefix(normalized, key) {
			return p, true
		}
	}
	if fb, ok := pricing[audit.FallbackPriceModel()]; ok {
		return fb, true
	}
	return config.ModelPrice{}, false
}
