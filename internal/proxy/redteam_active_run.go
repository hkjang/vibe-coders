package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"

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
	}
	return "", false
}

// redTeamActiveEligible reports whether a case against a target should be invoked live rather than
// simulated. Live invocation requires active-controlled mode, a redteam proxy key, and a concrete
// LLM/Text2SQL model target. MCP/tool/app/workflow targets are never invoked live in this path.
func redTeamActiveEligible(t store.RedTeamTarget, c store.RedTeamCampaign, proxyKey string) bool {
	if strings.TrimSpace(proxyKey) == "" {
		return false
	}
	if normalizeRedTeamMode(c.ExecutionMode) != "active-controlled" {
		return false
	}
	_, ok := pickRedTeamModel(t)
	return ok
}

// redTeamActiveInvoke sends one synthetic chat completion through the gateway as the redteam key
// and returns the assistant text, the request id, the HTTP status, and success. It sets the
// redteam cost-center/marker headers so the request is attributed and egress-tagged (§6).
func (s *Server) redTeamActiveInvoke(r *http.Request, proxyKey, model, prompt string, maxTokens int) (respText, requestID string, code int, ok bool) {
	if maxTokens <= 0 || maxTokens > 512 {
		maxTokens = 256
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

	rec := httptest.NewRecorder()
	s.handleOpenAI(rec, req)
	if rid := rec.Header().Get("X-Request-ID"); rid != "" {
		reqID = rid
	}
	if rec.Code != http.StatusOK {
		return "HTTP " + itoaProxy(rec.Code), reqID, rec.Code, false
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		return rec.Body.String(), reqID, rec.Code, true
	}
	if len(parsed.Choices) > 0 {
		return parsed.Choices[0].Message.Content, reqID, rec.Code, true
	}
	return "", reqID, rec.Code, true
}

// evaluateRedTeamCaseActive runs one probe case live and evaluates the real response with the Rule
// Evaluator. It mirrors evaluateRedTeamCase's return shape so the runner can treat both uniformly.
// The returned invoked=false means the live call failed and the caller should fall back.
func (s *Server) evaluateRedTeamCaseActive(r *http.Request, proxyKey string, t store.RedTeamTarget, pack store.RedTeamProbePack, cs store.RedTeamProbeCase, c store.RedTeamCampaign) (store.RedTeamCaseResult, store.RedTeamEvidence, store.RedTeamRemediation, bool) {
	model, ok := pickRedTeamModel(t)
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
	respText, requestID, httpCode, invoked := s.redTeamActiveInvoke(r, proxyKey, model, prompt, maxTokens)
	if !invoked {
		return store.RedTeamCaseResult{}, store.RedTeamEvidence{}, store.RedTeamRemediation{}, false
	}

	expected := redTeamExpectedDecision(cs.ExpectedPolicy)
	findings := redteamLeakFindings(respText)
	refused := redteamResponseRefused(respText)
	decision, policy := redteamRuleVerdict(cs.ExpectedPolicy, findings, refused, cs.Severity)

	maskedPrompt := audit.Redact(prompt)
	maskedResponse := audit.Redact(respText)
	hash := audit.HashText(maskedPrompt + "|" + maskedResponse)

	result := store.RedTeamCaseResult{
		RequestID: requestID, Decision: decision, Severity: normalizeRedTeamSeverity(cs.Severity),
		PolicyDecision: policy, EvidenceHash: hash, LatencyMS: 0, CostKRW: 0.5,
	}
	ev := store.RedTeamEvidence{
		MaskedPrompt: maskedPrompt, MaskedResponse: maskedResponse,
		ToolCalls: []map[string]any{},
		HeadersSummary: map[string]any{
			"x-redteam": true, "x-cost-center": "redteam", "mode": "active-controlled",
			"target": t.TargetRef, "pack": pack.ID, "model": model,
			"http_status": httpCode, "expected": expected, "leak_findings": findings,
		},
		ExportHash: hash,
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
