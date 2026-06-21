package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// remediationAction is one candidate fix for a situation. Executable actions map to an existing,
// reversible mutator; advisory ones only point the operator at the right screen.
type remediationAction struct {
	ID             string         `json:"id"`
	Type           string         `json:"type"`
	Title          string         `json:"title"`
	Description    string         `json:"description"`
	Severity       string         `json:"severity"` // critical | warning | info
	Executable     bool           `json:"executable"`
	Reversible     bool           `json:"reversible"`
	DryRun         string         `json:"dry_run"`         // predicted effect, no mutation
	ExpectedImpact string         `json:"expected_impact"` // who/what is affected
	Params         map[string]any `json:"params,omitempty"`
	Link           string         `json:"link,omitempty"`
}

type remediationPlaybook struct {
	Situation string              `json:"situation"`
	Severity  string              `json:"severity"`
	Summary   string              `json:"summary"`
	Actions   []remediationAction `json:"actions"`
}

// executableRemediations is the whitelist of action types POST /apply will actually perform.
// Every one maps to an existing reversible mutator; financial/routing changes stay advisory.
var executableRemediations = map[string]bool{
	"gateway_kill": true, "gateway_resume": true,
	"text2sql_kill": true, "text2sql_resume": true,
	"provider_disable": true, "provider_enable": true,
	"mcp_tool_block": true, "mcp_tool_allow": true,
}

// handleRemediationPlaybooks derives current operational situations from the same signals the
// incident copilot uses and proposes reversible action candidates (dry-run + expected impact).
// Read-only. GET /admin/remediation/playbooks[?window=]
func (s *Server) handleRemediationPlaybooks(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	since := parseWindow(r.URL.Query().Get("window"), 6*time.Hour, "hour")
	books := []remediationPlaybook{}
	worst := "info"
	bump := func(sev string) {
		if severityRank(sev) > severityRank(worst) {
			worst = sev
		}
	}

	// 1) Provider degraded → disable the worst provider (reversible) + fallback advisory.
	if scores, err := s.db.ProviderHealthScores(ctx, since); err == nil {
		for _, ps := range scores {
			if ps.Requests < 10 || ps.Score >= 70 {
				continue
			}
			sev := "warning"
			if ps.Score < 50 {
				sev = "critical"
			}
			bump(sev)
			books = append(books, remediationPlaybook{
				Situation: "provider_degraded", Severity: sev,
				Summary: "프로바이더 " + ps.Provider + " 건강도 " + itoaProxy(ps.Score) + "/100 (5xx " + itoaProxy(int(ps.Rate5xx)) + ", 429 " + itoaProxy(int(ps.Rate429)) + ", 폴백 " + itoaProxy(int(ps.Fallbacks)) + ")",
				Actions: []remediationAction{{
					ID: newID("rem"), Type: "provider_disable", Title: ps.Provider + " 임시 비활성화",
					Description: "건강도가 낮은 프로바이더를 비활성화해 라우팅에서 제외합니다. 복구 시 재활성화하세요.",
					Severity:    sev, Executable: true, Reversible: true,
					DryRun:         "provider." + ps.Provider + ".enabled = false (현재 라우팅 대상에서 제외, 기존 요청 영향 없음)",
					ExpectedImpact: "해당 프로바이더로 향하던 요청이 폴백/대체 프로바이더로 이동합니다.",
					Params:         map[string]any{"provider": ps.Provider},
				}},
			})
		}
	}

	// 2) Cost spike → advisory (budget cap is a financial change; keep human-in-the-loop).
	if anomalies, err := s.db.CostAnomalies(ctx, 7*24*time.Hour, 24*time.Hour, 3); err == nil {
		for _, a := range anomalies {
			if a.Direction != "up" {
				continue
			}
			sev := "warning"
			if a.ZScore >= 5 {
				sev = "critical"
			}
			bump(sev)
			books = append(books, remediationPlaybook{
				Situation: "cost_spike", Severity: sev,
				Summary: a.Scope + " " + a.ScopeValue + " 비용 급증 (z=" + ftoa(a.ZScore) + ", 최근 " + ftoa(a.RecentValue) + " vs 평소 " + ftoa(a.BaselineMean) + ")",
				Actions: []remediationAction{{
					ID: newID("rem"), Type: "budget_cap_advisory", Title: a.Scope + " 예산 한도 검토",
					Description: "비용 급증 대상에 월 예산 한도를 설정하거나 낮추는 것을 검토하세요. 금전적 영향이 있어 자동 적용하지 않습니다.",
					Severity:    sev, Executable: false, Reversible: true,
					DryRun:         "예산 화면에서 " + a.Scope + "=" + a.ScopeValue + " 한도를 설정/조정 (수동)",
					ExpectedImpact: "한도 초과 시 해당 범위의 신규 요청이 차단될 수 있습니다.",
					Params:         map[string]any{"scope": a.Scope, "scope_value": a.ScopeValue},
					Link:           "#/billing",
				}},
			})
		}
	}

	// 3) MCP error spike → block the worst MCP tool (reversible).
	if calls, errCnt, err := s.db.ToolMetricsSince(ctx, since); err == nil && calls >= 20 {
		rate := float64(errCnt) / float64(calls)
		if rate >= 0.05 {
			sev := "warning"
			if rate >= 0.2 {
				sev = "critical"
			}
			bump(sev)
			pb := remediationPlaybook{
				Situation: "mcp_error_spike", Severity: sev,
				Summary: "MCP 도구 오류율 " + ftoa(rate*100) + "% (" + itoaProxy(int(errCnt)) + "/" + itoaProxy(int(calls)) + ")",
			}
			if tools, err := s.db.ListMCPTools(ctx, store.ToolFilter{MCPOnly: true, Since: since, Limit: 50}); err == nil {
				worstTool := pickWorstMCPTool(tools)
				if worstTool != nil {
					pb.Actions = append(pb.Actions, remediationAction{
						ID: newID("rem"), Type: "mcp_tool_block", Title: worstTool.ServerLabel + "/" + worstTool.ToolName + " 차단",
						Description: "오류율이 높은 MCP 도구의 위험 정책을 block으로 설정합니다. 안정화 후 allow로 되돌리세요.",
						Severity:    sev, Executable: true, Reversible: true,
						DryRun:         "tool_risk[" + worstTool.ServerLabel + "/" + worstTool.ToolName + "].action = block (오류율 " + ftoa(worstTool.ErrorRate*100) + "%)",
						ExpectedImpact: "해당 도구 호출이 차단됩니다. 이 도구에 의존하는 에이전트 작업이 영향받습니다.",
						Params:         map[string]any{"server": worstTool.ServerLabel, "tool": worstTool.ToolName},
					})
				}
			}
			books = append(books, pb)
		}
	}

	// 4) Text2SQL risk spike → kill switch (reversible).
	if logs, err := s.db.RiskyText2SQLLogs(ctx, since, 0, 300); err == nil {
		rejected := 0
		for _, l := range logs {
			if !l.Valid {
				rejected++
			}
		}
		if rejected >= 20 {
			bump("warning")
			books = append(books, remediationPlaybook{
				Situation: "text2sql_risk_spike", Severity: "warning",
				Summary: "최근 거부된 Text2SQL 요청 " + itoaProxy(rejected) + "건",
				Actions: []remediationAction{{
					ID: newID("rem"), Type: "text2sql_kill", Title: "Text2SQL 일시 중지",
					Description: "위험 요청이 급증하면 Text2SQL 파이프라인을 일시 중지할 수 있습니다. 조사 후 재개하세요.",
					Severity:    "warning", Executable: true, Reversible: true,
					DryRun:         "text2sql.runtime_kill = true (신규 Text2SQL 요청 차단, 일반 채팅 영향 없음)",
					ExpectedImpact: "모든 Text2SQL(자연어→SQL) 요청이 중지됩니다.",
				}},
			})
		}
	}

	// 5) Policy violation spike → advisory (tighten policy via regression/governance).
	if events, err := s.db.ListPolicyDecisionEventsFiltered(ctx, store.PolicyDecisionFilter{Decision: "block", Since: since, Limit: 1000}); err == nil && len(events) >= 30 {
		bump("warning")
		books = append(books, remediationPlaybook{
			Situation: "policy_violation_spike", Severity: "warning",
			Summary: "최근 정책 차단 " + itoaProxy(len(events)) + "건 — 정책 점검 권장",
			Actions: []remediationAction{{
				ID: newID("rem"), Type: "policy_review_advisory", Title: "정책/회귀 테스트 점검",
				Description: "차단 급증의 원인 규칙을 확인하고 정책 회귀 테스트로 의도치 않은 차단인지 검증하세요.",
				Severity:    "warning", Executable: false, Reversible: true,
				DryRun:         "정책 화면에서 차단 규칙 검토 (수동)",
				ExpectedImpact: "정책 조정 시 차단/허용 결정이 바뀔 수 있습니다.",
				Link:           "#/safety",
			}},
		})
	}

	// 6) Break-glass: global kill switch is always available as a last resort.
	books = append(books, remediationPlaybook{
		Situation: "break_glass", Severity: "info",
		Summary: "비상 차단 — 전체 게이트웨이를 즉시 중지합니다 (가역).",
		Actions: []remediationAction{{
			ID: newID("rem"), Type: "gateway_kill", Title: "전체 게이트웨이 긴급 정지",
			Description: "심각한 사고 시 모든 /v1 호출을 즉시 차단합니다. 정상화되면 재개하세요.",
			Severity:    "info", Executable: true, Reversible: true,
			DryRun:         "gateway_disabled = true (모든 /v1 호출이 HTTP 503으로 응답)",
			ExpectedImpact: "전체 사용자/팀의 모든 요청이 중단됩니다. 최후의 수단으로만 사용하세요.",
		}},
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"overall_severity": worst,
		"window_hours":     int(time.Since(since).Hours() + 0.5),
		"playbooks":        books,
		"note":             "조치 후보는 dry-run 설명과 예상 영향을 포함합니다. 실제 적용은 관리자가 POST /admin/remediation/apply로 승인 실행하며, 가역 조치는 rollback 디스크립터를 함께 반환합니다.",
	})
}

func pickWorstMCPTool(tools []store.MCPToolStat) *store.MCPToolStat {
	var worst *store.MCPToolStat
	for i := range tools {
		t := tools[i]
		if t.Calls < 5 || t.ToolName == "" {
			continue
		}
		if worst == nil || t.ErrorRate > worst.ErrorRate {
			w := t
			worst = &w
		}
	}
	return worst
}

// handleRemediationApply executes one approved remediation action (admin auth IS the approval
// gate). Captures the prior state, performs the reversible mutation unless dry_run, audits it,
// and returns a rollback descriptor. POST /admin/remediation/apply
func (s *Server) handleRemediationApply(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		ActionType string         `json:"action_type"`
		Params     map[string]any `json:"params"`
		Reason     string         `json:"reason"`
		DryRun     bool           `json:"dry_run"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	at := strings.TrimSpace(p.ActionType)
	if !executableRemediations[at] {
		writeOpenAIError(w, http.StatusBadRequest, "action_type is not an executable remediation", "invalid_request_error", "not_executable")
		return
	}
	ctx := r.Context()
	if p.Params == nil {
		p.Params = map[string]any{}
	}
	paramStr := func(k string) string { v, _ := p.Params[k].(string); return strings.TrimSpace(v) }

	before := map[string]any{}
	after := map[string]any{}
	var rollback map[string]any
	var apply func() error

	switch at {
	case "gateway_kill", "gateway_resume":
		disable := at == "gateway_kill"
		snap := s.killSnapshot(ctx)
		before["gateway_disabled"] = snap != nil && snap.disabled
		after["gateway_disabled"] = disable
		rollback = map[string]any{"action_type": ternaryStr(disable, "gateway_resume", "gateway_kill")}
		apply = func() error {
			if err := s.db.SetFlag(ctx, store.RuntimeFlag{Key: "gateway_disabled", Value: boolStr(disable), UpdatedAt: time.Now().UTC(), UpdatedBy: adminID(r), Note: "remediation: " + p.Reason}); err != nil {
				return err
			}
			s.invalidateKillCache()
			return nil
		}
	case "text2sql_kill", "text2sql_resume":
		disable := at == "text2sql_kill"
		before["text2sql_killed"] = s.t2sKilled.Load()
		after["text2sql_killed"] = disable
		rollback = map[string]any{"action_type": ternaryStr(disable, "text2sql_resume", "text2sql_kill")}
		apply = func() error { s.t2sKilled.Store(disable); return nil }
	case "provider_disable", "provider_enable":
		name := paramStr("provider")
		if name == "" {
			writeOpenAIError(w, http.StatusBadRequest, "params.provider is required", "invalid_request_error", "missing_provider")
			return
		}
		prov, found, err := s.db.GetProvider(ctx, name)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "provider_lookup_failed")
			return
		}
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "provider not found", "invalid_request_error", "not_found")
			return
		}
		enable := at == "provider_enable"
		before["provider"] = name
		before["enabled"] = prov.Enabled
		after["enabled"] = enable
		rollback = map[string]any{"action_type": ternaryStr(enable, "provider_disable", "provider_enable"), "params": map[string]any{"provider": name}}
		apply = func() error { prov.Enabled = enable; return s.db.UpsertProvider(ctx, prov) }
	case "mcp_tool_block", "mcp_tool_allow":
		server, tool := paramStr("server"), paramStr("tool")
		if tool == "" {
			writeOpenAIError(w, http.StatusBadRequest, "params.tool is required", "invalid_request_error", "missing_tool")
			return
		}
		prior, _, _ := s.db.ToolRiskProfile(ctx, server, tool)
		action := "block"
		risk := "critical"
		if at == "mcp_tool_allow" {
			action, risk = "allow", "low"
		}
		before["server"] = server
		before["tool"] = tool
		before["action"] = firstNonEmpty(prior.Action, "allow")
		after["action"] = action
		rollback = map[string]any{"action_type": ternaryStr(at == "mcp_tool_block", "mcp_tool_allow", "mcp_tool_block"), "params": map[string]any{"server": server, "tool": tool}}
		apply = func() error {
			return s.db.UpsertToolRiskProfile(ctx, store.ToolRiskProfile{ServerLabel: server, ToolName: tool, RiskLevel: risk, Action: action, Note: "remediation: " + p.Reason})
		}
	}

	if p.DryRun {
		writeJSON(w, http.StatusOK, map[string]any{
			"applied": false, "dry_run": true, "action_type": at,
			"before": before, "after": after, "rollback": rollback,
			"note": "dry-run: 변경이 적용되지 않았습니다.",
		})
		return
	}
	if err := apply(); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "apply_failed")
		return
	}
	s.auditAdmin(r, "remediation.apply."+at, auditJSON(before), auditJSON(map[string]any{"after": after, "reason": p.Reason}))
	writeJSON(w, http.StatusOK, map[string]any{
		"applied": true, "dry_run": false, "action_type": at,
		"before": before, "after": after, "rollback": rollback,
		"note": "조치가 적용되었습니다. rollback 디스크립터로 되돌릴 수 있습니다.",
	})
}

func ternaryStr(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}
