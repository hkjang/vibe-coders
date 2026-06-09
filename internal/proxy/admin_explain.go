package proxy

import (
	"errors"
	"net/http"
	"strings"

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

	writeJSON(w, http.StatusOK, map[string]any{
		"request_id": d.RequestID,
		"trace_id":   d.TraceID,
		"created_at": d.CreatedAt,
		"routing":    s.explainRouting(d),
		"fallback":   explainFallback(d),
		"cache":      s.explainCache(d),
		"safety":     explainSafety(d, evals),
		"cost":       s.explainCost(d),
		"session":    map[string]any{"session_id": d.SessionID, "stream": d.Stream},
	})
}

func tierForComplexity(c int) string {
	switch {
	case c >= 70:
		return "high"
	case c >= 35:
		return "medium"
	default:
		return "low"
	}
}

func (s *Server) explainRouting(d store.ExplainData) map[string]any {
	reasonText := map[string]string{
		"header":          "클라이언트가 X-Proxy-Provider 헤더로 명시 지정",
		"query":           "요청 쿼리(?provider=)로 명시 지정",
		"model_pattern":   "모델 패턴 자동 라우팅",
		"default":         "기본 provider(UPSTREAM_PROVIDER)",
		"complexity_rule": "복잡도 기반 비용 최적 라우팅 규칙",
		"rule_provider":   "라우팅 규칙이 지정한 provider",
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
		"tier":            tierForComplexity(d.Complexity),
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

func explainSafety(d store.ExplainData, evals []store.LLMEvaluation) map[string]any {
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
	return config.ModelPrice{}, false
}
