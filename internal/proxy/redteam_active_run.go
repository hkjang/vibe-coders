package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// Active Controlled Run (요건 §8) — the safe live-invocation path for Red Team campaigns.
//
// Unlike the simulation, this actually sends a synthetic /v1/chat/completions request through the
// gateway using a caller-supplied redteam Proxy API Key (전용 key, §6), captures the real response,
// and judges it with the content Rule Evaluator. It is deliberately narrow: only LLM `model` and
// `text2sql` targets are invoked live; providers-without-a-model, MCP tools, apps, and workflows
// keep the simulation. Destructive/high-risk MCP surfaces are NEVER invoked here. A global kill
// switch and the campaign budget guard can abort the run mid-flight.

// redteamKillSwitch, when true, halts all Active Controlled Runs (§22 Kill Switch).
var redteamKillSwitch atomic.Bool

const redteamActiveMaxCalls = 200 // hard safety cap on live calls per run

// handleRedTeamKillSwitch reads or toggles the global red-team runner kill switch.
// GET returns state; POST {enabled:bool} sets it. Requires admin.
func (s *Server) handleRedTeamKillSwitch(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"enabled": redteamKillSwitch.Load()})
	case http.MethodPost:
		var body struct {
			Enabled bool `json:"enabled"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&body)
		redteamKillSwitch.Store(body.Enabled)
		s.auditAdmin(r, "redteam.kill_switch", "", auditJSON(map[string]any{"enabled": body.Enabled}))
		writeJSON(w, http.StatusOK, map[string]any{"enabled": body.Enabled})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// pickRedTeamModel returns a concrete model name for live invocation, if the target has one.
// Wildcard-only patterns (e.g. "*") cannot be invoked and fall back to simulation.
func pickRedTeamModel(t store.RedTeamTarget) (string, bool) {
	switch t.TargetType {
	case "model", "text2sql":
		m := strings.TrimSpace(t.Model)
		if m == "" || strings.Contains(m, "*") {
			return "", false
		}
		return m, true
	case "provider":
		// A provider target has no single model; derive one from its model patterns
		// (first concrete, non-wildcard token) so provider-scoped campaigns can run live.
		if t.Metadata != nil {
			if mp, ok := t.Metadata["model_patterns"].(string); ok {
				for _, tok := range strings.Split(mp, ",") {
					tok = strings.TrimSpace(tok)
					if tok != "" && !strings.Contains(tok, "*") {
						return tok, true
					}
				}
			}
		}
		return "", false
	}
	return "", false
}

// redTeamActiveEligible reports whether a case against a target should be invoked live rather than
// simulated. Live invocation requires active-controlled mode, a redteam proxy key, and an LLM-type
// target (provider/model/text2sql). The concrete model is resolved at call time — for provider/model
// targets without a concrete pattern it is auto-discovered from the upstream /v1/models. MCP tool,
// app, and workflow targets are never invoked live in this path.
func redTeamActiveEligible(t store.RedTeamTarget, c store.RedTeamCampaign, proxyKey string) bool {
	if strings.TrimSpace(proxyKey) == "" {
		return false
	}
	if normalizeRedTeamMode(c.ExecutionMode) != "active-controlled" {
		return false
	}
	switch t.TargetType {
	case "provider", "model", "text2sql":
		return true
	}
	return false
}

// redTeamModelCache memoizes the /v1/models list PER PROVIDER for one run, so auto-discovery costs
// at most one extra call per provider. Keyed by provider name ("" = default/all).
type redTeamModelCache struct {
	byProvider map[string][]string
}

// redTeamListModels fetches the gateway's advertised model list as the redteam key, SCOPED to a
// single provider when given (via ?provider=). Scoping matters: the gateway's /v1/models is the
// union of every provider's catalogue, so an unscoped list could hand a provider target a model
// that belongs to a different upstream — which then 404s when routed to the intended provider.
func (s *Server) redTeamListModels(r *http.Request, proxyKey, provider string) []string {
	path := "/v1/models"
	if p := strings.TrimSpace(provider); p != "" && p != "text2sql" {
		path += "?provider=" + url.QueryEscape(p)
	}
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req = req.WithContext(r.Context())
	req.RemoteAddr = r.RemoteAddr
	req.Header.Set("Authorization", "Bearer "+proxyKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Cost-Center", "redteam")
	req.Header.Set("X-Redteam", "1")
	rec := httptest.NewRecorder()
	s.handleOpenAI(rec, req)
	if rec.Code != http.StatusOK {
		return nil
	}
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		return nil
	}
	out := []string{}
	for _, m := range parsed.Data {
		if strings.TrimSpace(m.ID) != "" {
			out = append(out, m.ID)
		}
	}
	return out
}

// resolveRedTeamModel returns the concrete model to invoke for a target: a concrete model pattern
// if present, otherwise (for provider/model targets) one auto-discovered from that provider's
// /v1/models, preferring an id that matches the provider's pattern prefix. Returns ("", "", false)
// if none can be resolved.
func (s *Server) resolveRedTeamModel(r *http.Request, proxyKey string, t store.RedTeamTarget, cache *redTeamModelCache) (model, provider string, ok bool) {
	if m, pok := pickRedTeamModel(t); pok {
		return m, t.Provider, true
	}
	return s.redTeamCatalogModel(r, proxyKey, t, cache)
}

// redTeamCatalogModel picks a REAL model for a provider/model target from that provider's live
// /v1/models — ignoring the target's own (possibly stale/nonexistent) model. Prefers an id matching
// the provider's pattern prefix, else the first advertised model. Used as the 404 fallback when a
// pinned or target model does not actually exist at the provider.
func (s *Server) redTeamCatalogModel(r *http.Request, proxyKey string, t store.RedTeamTarget, cache *redTeamModelCache) (model, provider string, ok bool) {
	if t.TargetType != "provider" && t.TargetType != "model" {
		return "", "", false
	}
	var models []string
	if cache != nil {
		if cache.byProvider == nil {
			cache.byProvider = map[string][]string{}
		}
		if cached, seen := cache.byProvider[t.Provider]; seen {
			models = cached
		} else {
			models = s.redTeamListModels(r, proxyKey, t.Provider)
			cache.byProvider[t.Provider] = models
		}
	} else {
		models = s.redTeamListModels(r, proxyKey, t.Provider)
	}
	if len(models) == 0 {
		return "", "", false
	}
	// Prefer a model whose id matches the provider's pattern prefix (e.g. "gpt-4o*" → "gpt-4o...").
	if t.Metadata != nil {
		if mp, mok := t.Metadata["model_patterns"].(string); mok {
			for _, pat := range strings.Split(mp, ",") {
				pat = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(pat), "*"))
				if pat == "" {
					continue
				}
				for _, m := range models {
					if strings.HasPrefix(m, pat) {
						return m, t.Provider, true
					}
				}
			}
		}
	}
	return models[0], t.Provider, true
}

// resolvePatternToConcreteModel takes a wildcard model pattern (like "rdtand/*") and queries the
// target provider's live model list to find a matching concrete model. Falls back to the first
// available model if no match succeeds.
func (s *Server) resolvePatternToConcreteModel(r *http.Request, proxyKey string, t store.RedTeamTarget, pattern string, cache *redTeamModelCache) (string, string, bool) {
	if t.Provider == "" {
		return "", "", false
	}
	var models []string
	if cache != nil {
		if cache.byProvider == nil {
			cache.byProvider = map[string][]string{}
		}
		if cached, seen := cache.byProvider[t.Provider]; seen {
			models = cached
		} else {
			models = s.redTeamListModels(r, proxyKey, t.Provider)
			cache.byProvider[t.Provider] = models
		}
	} else {
		models = s.redTeamListModels(r, proxyKey, t.Provider)
	}
	if len(models) == 0 {
		return "", "", false
	}

	patLower := strings.ToLower(strings.TrimSpace(pattern))
	for _, m := range models {
		if matchGlob(patLower, strings.ToLower(m)) {
			return m, t.Provider, true
		}
	}
	return models[0], t.Provider, true
}


// redTeamThrottleQPS paces live probe invocations to at most `qps` calls per second by sleeping
// until the minimum inter-call interval has elapsed since the previous call. It updates *last to
// the effective call time. Returns false if the context is cancelled while waiting (caller aborts).
// qps <= 0 disables throttling. Pure timing — no external deps — so it is cheap and predictable.
func redTeamThrottleQPS(ctx context.Context, qps float64, last *time.Time) bool {
	if qps > 0 && !last.IsZero() {
		minInterval := time.Duration(float64(time.Second) / qps)
		if wait := minInterval - time.Since(*last); wait > 0 {
			timer := time.NewTimer(wait)
			defer timer.Stop()
			select {
			case <-timer.C:
			case <-ctx.Done():
				return false
			}
		}
	}
	*last = time.Now()
	return true
}

// redTeamActiveCall is the result of one live probe invocation: the (unmasked) assistant text,
// the gateway request id, HTTP status, measured wall-clock latency, and the real KRW cost derived
// from the response's usage via the runtime pricing map. cost/latency replace the earlier hardcoded
// placeholders so the budget guard and evidence reflect the actual spend.
type redTeamActiveCall struct {
	RespText  string
	RequestID string
	Code      int
	LatencyMS int64
	CostKRW   float64
	OK        bool
}

// redTeamActiveInvoke sends one synthetic chat completion through the gateway as the redteam key
// and returns the assistant text, request id, HTTP status, measured latency, real cost, and success.
// It sets the redteam cost-center/marker headers so the request is attributed and egress-tagged (§6).
func (s *Server) redTeamActiveInvoke(r *http.Request, proxyKey, model, provider, prompt, sessionID string, maxTokens int) redTeamActiveCall {
	if maxTokens <= 0 || maxTokens > 4096 {
		maxTokens = 2048
	}
	body := map[string]any{
		"model":       model,
		"messages":    []map[string]string{{"role": "user", "content": prompt}},
		"max_tokens":  maxTokens,
		"temperature": 0,
		"stream":      false,
	}
	encoded, _ := json.Marshal(body)
	reqID := newID("rt_probe")
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(encoded))
	req = req.WithContext(r.Context())
	req.RemoteAddr = r.RemoteAddr
	req.Header.Set("Authorization", "Bearer "+proxyKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "vibe-redteam-runner")
	req.Header.Set("X-Request-ID", reqID)
	req.Header.Set("X-Cost-Center", "redteam")
	req.Header.Set("X-Redteam", "1")
	// Tag every live probe with a stable redteam session id so the calls group into one session
	// in the call history / flight recorder, giving the operator a direct drill-in link.
	if strings.TrimSpace(sessionID) != "" {
		req.Header.Set("X-Session-ID", sessionID)
	}
	// Force routing to the intended provider so an auto-discovered model still hits the target.
	if strings.TrimSpace(provider) != "" && provider != "text2sql" {
		req.Header.Set("X-Proxy-Provider", provider)
	}

	start := time.Now()
	rec := httptest.NewRecorder()
	s.handleOpenAI(rec, req)
	latency := time.Since(start).Milliseconds()
	if rid := rec.Header().Get("X-Request-ID"); rid != "" {
		reqID = rid
	}
	if rec.Code != http.StatusOK {
		// The call WAS made and the gateway/upstream answered with an error (e.g. 404 model-not-found,
		// 401 key, 5xx). Capture the error body so the operator sees the real reason in the evidence,
		// and mark OK so the runner records it as a visible result instead of silently simulating.
		body := strings.TrimSpace(rec.Body.String())
		if len(body) > 2000 {
			body = body[:2000]
		}
		return redTeamActiveCall{RespText: "HTTP " + itoaProxy(rec.Code) + ": " + body, RequestID: reqID, Code: rec.Code, LatencyMS: latency, OK: true}
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		return redTeamActiveCall{RespText: rec.Body.String(), RequestID: reqID, Code: rec.Code, LatencyMS: latency, OK: true}
	}
	cost := audit.EstimateCostKRW(model, audit.Usage{
		PromptTokens:     parsed.Usage.PromptTokens,
		CompletionTokens: parsed.Usage.CompletionTokens,
		TotalTokens:      parsed.Usage.TotalTokens,
	}, s.pricingMap(r.Context()))
	text := ""
	if len(parsed.Choices) > 0 {
		msg := parsed.Choices[0].Message
		if msg.ReasoningContent != "" {
			text = "<thinking>\n" + msg.ReasoningContent + "\n</thinking>\n\n" + msg.Content
		} else {
			text = msg.Content
		}
	}
	return redTeamActiveCall{RespText: text, RequestID: reqID, Code: rec.Code, LatencyMS: latency, CostKRW: cost, OK: true}
}

// rerunRedTeamCaseLive re-executes a single stored result as a real active-controlled call with raw
// evidence retention forced on, then rewrites that result and its evidence in place. This lets an
// operator see the actual request/response (and the real model verdict) for a case that was first
// produced by simulation or without raw retention — without re-running the whole campaign.
func (s *Server) rerunRedTeamCaseLive(r *http.Request, resultID, proxyKey string) (map[string]any, error) {
	if redteamKillSwitch.Load() {
		return nil, fmt.Errorf("레드팀 킬 스위치가 켜져 있어 실제 재실행이 중지되어 있습니다")
	}
	if strings.TrimSpace(proxyKey) == "" {
		return nil, fmt.Errorf("실제 재실행에는 전용 레드팀 Proxy API Key가 필요합니다")
	}
	res, found, err := s.db.GetRedTeamCaseResult(r.Context(), resultID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("결과를 찾을 수 없습니다")
	}
	run, found, err := s.db.GetRedTeamRun(r.Context(), res.RunID)
	if err != nil || !found {
		return nil, fmt.Errorf("실행(run) 정보를 찾을 수 없습니다")
	}
	campaign, found, err := s.db.GetRedTeamCampaign(r.Context(), run.CampaignID)
	if err != nil || !found {
		return nil, fmt.Errorf("캠페인 정보를 찾을 수 없습니다")
	}
	cs, found, err := s.db.GetRedTeamProbeCase(r.Context(), res.CaseID)
	if err != nil || !found {
		return nil, fmt.Errorf("프로브 케이스를 찾을 수 없습니다")
	}
	target, found, err := s.db.GetRedTeamTarget(r.Context(), run.TargetID)
	if err != nil || !found {
		return nil, fmt.Errorf("대상(target)을 찾을 수 없습니다")
	}
	// Force a live call with raw retention for this single re-run, regardless of the campaign config.
	campaign.ExecutionMode = "active-controlled"
	campaign.RetainRawEvidence = true
	if !redTeamActiveEligible(target, campaign, proxyKey) {
		return nil, fmt.Errorf("이 대상 유형(%s)은 실제 호출 대상이 아니라 재실행할 수 없습니다(MCP 도구·앱·워크플로는 시뮬레이션 전용)", target.TargetType)
	}
	ar, aev, arem, invoked := s.evaluateRedTeamCaseActive(r, proxyKey, target, store.RedTeamProbePack{ID: cs.PackID}, cs, campaign, &redTeamModelCache{}, "")
	if !invoked {
		return nil, fmt.Errorf("실제 호출에 실패했습니다(모델 미해결 또는 upstream 오류). 대상/키를 확인하세요")
	}
	// Rewrite the SAME result row + its evidence so the existing UI links keep working.
	ar.ID, ar.RunID, ar.CaseID, ar.CreatedAt = res.ID, res.RunID, res.CaseID, res.CreatedAt
	aev.ID, aev.ResultID = newID("rtev"), res.ID
	ar.EvidenceHash = aev.ExportHash
	if err := s.db.UpdateRedTeamCaseResult(r.Context(), ar); err != nil {
		return nil, err
	}
	if err := s.db.InsertRedTeamEvidence(r.Context(), aev); err != nil {
		return nil, err
	}
	if arem.ActionType != "" {
		arem.ID, arem.ResultID = newID("rtrm"), res.ID
		_ = s.db.InsertRedTeamRemediation(r.Context(), arem)
	}
	s.auditAdmin(r, "redteam.result.rerun", "", auditJSON(map[string]any{"result_id": res.ID, "decision": ar.Decision, "model": aev.HeadersSummary["model"]}))
	return map[string]any{
		"result_id": res.ID, "decision": ar.Decision, "policy_decision": ar.PolicyDecision,
		"severity": ar.Severity, "cost_krw": ar.CostKRW,
		"note": "원문 보관으로 실제 재실행했습니다. 증적에서 실제 요청/응답을 확인하세요.",
	}, nil
}

// evaluateRedTeamCaseActive runs one probe case live and evaluates the real response with the Rule
// Evaluator. It mirrors evaluateRedTeamCase's return shape so the runner can treat both uniformly.
// The returned invoked=false means the live call failed and the caller should fall back.
func (s *Server) evaluateRedTeamCaseActive(r *http.Request, proxyKey string, t store.RedTeamTarget, pack store.RedTeamProbePack, cs store.RedTeamProbeCase, c store.RedTeamCampaign, cache *redTeamModelCache, forcedModel string) (store.RedTeamCaseResult, store.RedTeamEvidence, store.RedTeamRemediation, bool) {
	var model, provider string
	var ok bool
	// A forced model (from the campaign's model selection) is used directly for provider/model
	// targets; otherwise the model is auto-resolved from the upstream /v1/models.
	if forcedModel != "" && (t.TargetType == "provider" || t.TargetType == "model") {
		if strings.Contains(forcedModel, "*") {
			var resolved bool
			model, provider, resolved = s.resolvePatternToConcreteModel(r, proxyKey, t, forcedModel, cache)
			if resolved {
				ok = true
			}
		} else {
			model, provider, ok = forcedModel, t.Provider, true
		}
	} else {
		model, provider, ok = s.resolveRedTeamModel(r, proxyKey, t, cache)
	}
	if !ok {
		return store.RedTeamCaseResult{}, store.RedTeamEvidence{}, store.RedTeamRemediation{}, false
	}
	prompt := redTeamRenderTemplate(cs.InputTemplate, t, pack)
	maxTokens := 0
	if cs.Parameters != nil {
		if mt, mok := cs.Parameters["max_tokens"].(float64); mok {
			maxTokens = int(mt)
		}
	}
	sessionID := "redteam:" + c.ID
	call := s.redTeamActiveInvoke(r, proxyKey, model, provider, prompt, sessionID, maxTokens)
	if !call.OK {
		return store.RedTeamCaseResult{}, store.RedTeamEvidence{}, store.RedTeamRemediation{}, false
	}

	expected := redTeamExpectedDecision(cs.ExpectedPolicy)
	var findings []string
	var decision, policy string
	if call.Code >= 400 {
		// The probe could not be delivered/answered (upstream error). Record it as an explicit
		// error outcome — NOT a pass/fail of the model's safety — so the operator can fix routing
		// (e.g. a 404 usually means the resolved model does not exist at the target provider).
		decision, policy = "error", "upstream_error_"+itoaProxy(call.Code)
	} else {
		findings = redteamLeakFindings(call.RespText)
		refused := redteamResponseRefused(call.RespText)
		decision, policy = redteamRuleVerdict(cs.ExpectedPolicy, findings, refused, cs.Severity)
	}

	maskedPrompt := audit.Redact(prompt)
	maskedResponse := audit.Redact(call.RespText)
	hash := audit.HashText(maskedPrompt + "|" + maskedResponse)

	// A successful call with no usage (some providers omit it) still consumed budget; charge a
	// nominal floor so the per-run budget guard cannot be defeated by a missing usage block.
	costKRW := call.CostKRW
	if costKRW <= 0 {
		costKRW = 0.5
	}
	result := store.RedTeamCaseResult{
		RequestID: call.RequestID, Decision: decision, Severity: normalizeRedTeamSeverity(cs.Severity),
		PolicyDecision: policy, EvidenceHash: hash, LatencyMS: call.LatencyMS, CostKRW: costKRW,
	}
	ev := store.RedTeamEvidence{
		MaskedPrompt: maskedPrompt, MaskedResponse: maskedResponse,
		ToolCalls: []map[string]any{},
		HeadersSummary: map[string]any{
			"x-redteam": true, "x-cost-center": "redteam", "mode": "active-controlled",
			"target": t.TargetRef, "pack": pack.ID, "provider": provider, "model": model,
			"http_status": call.Code, "expected": expected, "leak_findings": findings,
			"latency_ms": call.LatencyMS, "cost_krw": costKRW,
			"seed_template": cs.InputTemplate, "session_id": sessionID,
		},
		ExportHash: hash,
	}
	// Opt-in raw evidence (관리자 검토용): the actual rendered request and the real, unmasked model
	// response are retained only when the campaign explicitly enables it, so an admin can judge for
	// themselves whether a given provider/model is risky. Off by default (masked-only, §6/§29).
	if c.RetainRawEvidence {
		ev.RawPrompt = prompt
		ev.RawResponse = call.RespText
	}
	var rem store.RedTeamRemediation
	if decision == "warning" || decision == "fail" || decision == "critical" {
		rem = store.RedTeamRemediation{
			ActionType: redTeamRemediationType(t),
			ActionPayload: map[string]any{
				"target_id": t.ID, "target_type": t.TargetType, "target_ref": t.TargetRef,
				"pack_id": pack.ID, "case_id": cs.ID, "mode": "active-controlled",
				"leak_findings": findings, "recommendation": redTeamRemediationRecommendation(t, cs),
			},
			Status: "open", Owner: t.OwnerTeam,
		}
	}
	return result, ev, rem, true
}
