package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// postChangeRedTeamSpec is a safe routing plan from one successful admin mutation to
// a bounded Red Team simulation. It never carries secrets or raw changed values.
type postChangeRedTeamSpec struct {
	Scope       string
	Ref         string
	Reason      string
	Provider    string
	MCPUpstream string
	ToolName    string
	TargetType  string
	TargetRef   string
	ProbePacks  []string
}

// maybeRunPostChangeRedTeam turns security-sensitive admin changes into a restart-safe,
// deduplicated simulation campaign. It runs synchronously after the audit row is written so
// the original change still succeeds even when the regression check itself cannot be created.
func (s *Server) maybeRunPostChangeRedTeam(r *http.Request, action, before, after string) error {
	if !s.cfg.RedTeam.PostChangeEnabled || r == nil || redteamKillSwitch.Load() {
		return nil
	}
	spec, ok := classifyPostChangeRedTeam(action, before, after)
	if !ok {
		return nil
	}

	cooldown := s.redTeamPostChangeCooldown()
	// before/after are already the masked, intentionally bounded audit representations.
	// Persist only their digest, never the values themselves.
	fingerprint := audit.HashText(action + "|" + spec.Ref + "|" + before + "|" + after)
	if _, found, err := s.db.FindRecentRedTeamCampaignByFingerprint(r.Context(), fingerprint, time.Now().UTC().Add(-cooldown)); err != nil {
		return err
	} else if found {
		return nil
	}

	actor := adminID(r)
	if err := s.ensureDefaultRedTeamProbePacks(r.Context(), actor); err != nil {
		return err
	}
	if err := s.syncRedTeamTargets(r); err != nil {
		return err
	}
	targets, err := s.db.ListRedTeamTargets(r.Context(), store.RedTeamTargetFilter{EnabledOnly: true, Limit: 1000})
	if err != nil {
		return err
	}
	maxTargets := s.redTeamPostChangeMaxTargets()
	targetIDs := selectPostChangeRedTeamTargets(targets, spec, maxTargets)
	status := "draft"
	reason := spec.Reason
	if len(targetIDs) == 0 {
		status = "no-target"
		reason += " 등록된 활성 대상이 없어 실행을 건너뛰었습니다."
	}
	targetFilter := map[string]any{"target_ids": targetIDs}
	campaign := store.RedTeamCampaign{
		ID:                      newID("rtc"),
		Name:                    postChangeCampaignName(action, spec.Ref),
		Scope:                   spec.Scope,
		Status:                  status,
		ExecutionMode:           "dry-run",
		CreatedBy:               actor,
		Concurrency:             1,
		TargetFilter:            targetFilter,
		ProbePackIDs:            spec.ProbePacks,
		EvidenceRetentionDays:   30,
		ExternalProviderAllowed: false,
		DestructiveToolPolicy:   "dry-run",
		TriggerSource:           "post-change",
		TriggerAction:           action,
		TriggerRef:              spec.Ref,
		TriggerReason:           reason,
		TriggerFingerprint:      fingerprint,
	}
	if err := s.db.UpsertRedTeamCampaign(r.Context(), campaign); err != nil {
		return err
	}
	if len(targetIDs) == 0 {
		s.auditAdmin(r, "redteam.post_change.no_target", "", auditJSON(map[string]any{
			"campaign_id": campaign.ID, "action": action, "ref": spec.Ref,
		}))
		return nil
	}
	result, err := s.runRedTeamCampaign(r, campaign, "")
	if err != nil {
		_ = s.db.UpdateRedTeamCampaignStatus(r.Context(), campaign.ID, "failed", "")
		return err
	}
	s.auditAdmin(r, "redteam.post_change.completed", "", auditJSON(map[string]any{
		"campaign_id": campaign.ID,
		"action":      action,
		"ref":         spec.Ref,
		"targets":     len(targetIDs),
		"summary":     result["summary"],
	}))
	return nil
}

func (s *Server) redTeamPostChangeCooldown() time.Duration {
	if s.cfg.RedTeam.PostChangeCooldown > 0 {
		return s.cfg.RedTeam.PostChangeCooldown
	}
	return 10 * time.Minute
}

func (s *Server) redTeamPostChangeMaxTargets() int {
	if s.cfg.RedTeam.PostChangeMaxTargets > 0 {
		return s.cfg.RedTeam.PostChangeMaxTargets
	}
	return 20
}

func classifyPostChangeRedTeam(action, before, after string) (postChangeRedTeamSpec, bool) {
	action = strings.ToLower(strings.TrimSpace(action))
	if action == "" || strings.HasPrefix(action, "redteam.") {
		return postChangeRedTeamSpec{}, false
	}
	beforeMap, afterMap := postChangeAuditMap(before), postChangeAuditMap(after)
	value := func(keys ...string) string {
		if v := postChangeAuditString(afterMap, keys...); v != "" {
			return v
		}
		return postChangeAuditString(beforeMap, keys...)
	}
	rawRef := func() string {
		if v := strings.TrimSpace(after); v != "" && !strings.HasPrefix(v, "{") && !strings.HasPrefix(v, "[") {
			return v
		}
		if v := strings.TrimSpace(before); v != "" && !strings.HasPrefix(v, "{") && !strings.HasPrefix(v, "[") {
			return v
		}
		return ""
	}
	spec := postChangeRedTeamSpec{}

	switch {
	case action == "provider.upsert" || action == "provider.delete" ||
		action == "provider_slo.upsert" || action == "provider_slo.delete":
		spec.Scope = "provider"
		spec.Provider = value("name", "provider")
		spec.Ref = firstNonEmpty(spec.Provider, "provider-registry")
		spec.Reason = "Provider 연결·모델 매핑·신뢰 경계 변경 후 라우팅과 egress 회귀를 자동 점검했습니다."
		spec.ProbePacks = []string{"rtp_model_routing_abuse", "rtp_header_trust", "rtp_data_leakage"}

	case action == "routing_rule.create" || action == "routing_rule.update" || action == "routing_rule.delete":
		spec.Scope = "provider"
		spec.Ref = firstNonEmpty(value("id", "name"), rawRef(), "routing-rules")
		spec.Reason = "라우팅 규칙 변경 후 alias·provider override·fallback 정책 경계를 자동 점검했습니다."
		spec.ProbePacks = []string{"rtp_model_routing_abuse", "rtp_header_trust", "rtp_policy_bypass"}

	case action == "mcp_upstream.upsert" || action == "mcp_upstream.update" || action == "mcp_upstream.delete":
		spec.Scope = "mcp"
		spec.MCPUpstream = value("id", "server_label", "namespace")
		spec.Ref = firstNonEmpty(spec.MCPUpstream, rawRef(), "mcp-upstreams")
		spec.Reason = "MCP upstream 변경 후 도구 오남용·인자 주입·승인 경계를 자동 점검했습니다."
		spec.ProbePacks = []string{"rtp_tool_misuse", "rtp_argument_injection", "rtp_policy_bypass"}

	case action == "mcp.tool_risk.upsert" || action == "mcp.policy.upsert" || action == "mcp.policy.delete" ||
		action == "mcp.allowlist" || action == "mcp_tool_contract_upsert" || action == "mcp_tool_contract_delete":
		spec.Scope = "mcp"
		spec.MCPUpstream = value("server_label", "namespace")
		spec.ToolName = value("tool_name", "name")
		spec.Ref = firstNonEmpty(strings.Trim(strings.Join([]string{spec.MCPUpstream, spec.ToolName}, "/"), "/"), rawRef(), "mcp-policy")
		spec.Reason = "MCP 도구 위험도 또는 정책 변경 후 권한·승인·파괴적 동작 방어를 자동 점검했습니다."
		spec.ProbePacks = []string{"rtp_tool_misuse", "rtp_argument_injection", "rtp_policy_bypass"}

	case action == "governance.policy.upsert" || action == "governance.policy.import" || action == "policy_advisor.apply":
		spec.Scope = "all"
		spec.Ref = firstNonEmpty(value("id", "policy_id", "name", "title"), "governance-policy")
		spec.Reason = "Governance 정책 변경 후 차단·승인·민감정보 처리 우회를 전체 대상에서 자동 점검했습니다."
		spec.ProbePacks = []string{"rtp_policy_bypass", "rtp_data_leakage", "rtp_regression"}

	case postChangeText2SQLAction(action):
		spec.Scope = "text2sql"
		spec.TargetType = "text2sql"
		spec.Ref = firstNonEmpty(value("virtual_model", "name", "schema", "schema_name", "id"), rawRef(), "text2sql")
		spec.Reason = "Text2SQL 스키마·권한·가드레일 변경 후 SELECT-only와 민감 데이터 경계를 자동 점검했습니다."
		spec.ProbePacks = []string{"rtp_text2sql_guardrail", "rtp_data_leakage", "rtp_policy_bypass"}

	case action == "workflow_upsert" || action == "workflow_delete" || action == "workflow.publish":
		spec.Scope = "workflow"
		spec.TargetType = "workflow"
		id := firstNonEmpty(value("id"), rawRef())
		spec.TargetRef = prefixedPostChangeRef("workflow:", id)
		spec.Ref = firstNonEmpty(id, "workflows")
		spec.Reason = "Workflow 단계·승인 흐름 변경 후 tool chain과 정책 경계를 자동 점검했습니다."
		spec.ProbePacks = []string{"rtp_tool_misuse", "rtp_policy_bypass", "rtp_regression"}

	case action == "work_app.create" || action == "work_app.publish" || action == "work_app.deprecate" ||
		action == "work_app.delete" || action == "work_app.permission_grant" || action == "work_app.permission_revoke" ||
		action == "app_template_instantiate":
		spec.Scope = "ai_app"
		spec.TargetType = "ai_app"
		id := firstNonEmpty(value("app_id", "id"), rawRef())
		spec.TargetRef = prefixedPostChangeRef("ai_app:", id)
		spec.Ref = firstNonEmpty(id, "ai-apps")
		spec.Reason = "AI App 구성 또는 권한 변경 후 prompt leakage와 권한 경계를 자동 점검했습니다."
		spec.ProbePacks = []string{"rtp_prompt_injection_basic", "rtp_data_leakage", "rtp_policy_bypass"}

	case action == "agent_route.upsert" || action == "agent_route.delete":
		spec.Scope = "provider,mcp"
		spec.Ref = firstNonEmpty(value("virtual_model", "id"), rawRef(), "agent-routes")
		spec.Reason = "Agent route 변경 후 모델 라우팅과 MCP tool 선택 경계를 자동 점검했습니다."
		spec.ProbePacks = []string{"rtp_model_routing_abuse", "rtp_tool_misuse", "rtp_policy_bypass"}

	case action == "change_set.apply" || action == "change_set.rollback":
		spec.Scope = "all"
		spec.Ref = firstNonEmpty(rawRef(), value("id"), "change-set")
		spec.Reason = "운영 변경 세트 적용 후 핵심 보안 회귀 팩을 등록 대상 전반에서 자동 점검했습니다."
		spec.ProbePacks = []string{"rtp_regression", "rtp_policy_bypass", "rtp_model_routing_abuse"}

	case action == "setting.update" || action == "setting.revert" || action == "setting.bulk" || action == "setting.rollback":
		key := firstNonEmpty(value("key"), rawRef())
		switch {
		case strings.HasPrefix(key, "mcp."):
			spec.Scope = "mcp"
			spec.ProbePacks = []string{"rtp_tool_misuse", "rtp_argument_injection", "rtp_policy_bypass"}
		case strings.HasPrefix(key, "text2sql."):
			spec.Scope = "text2sql"
			spec.TargetType = "text2sql"
			spec.ProbePacks = []string{"rtp_text2sql_guardrail", "rtp_data_leakage", "rtp_policy_bypass"}
		case action == "setting.bulk":
			spec.Scope = "all"
			spec.ProbePacks = []string{"rtp_regression", "rtp_policy_bypass"}
		default:
			return postChangeRedTeamSpec{}, false
		}
		spec.Ref = firstNonEmpty(key, "runtime-settings")
		spec.Reason = "런타임 보안 관련 설정 변경 후 대상별 안전 경계를 자동 점검했습니다."

	default:
		return postChangeRedTeamSpec{}, false
	}
	return spec, spec.Scope != "" && len(spec.ProbePacks) > 0
}

func postChangeText2SQLAction(action string) bool {
	switch action {
	case "text2sql.table.upsert", "text2sql.column.upsert", "text2sql.feature.toggle",
		"text2sql.promote.glossary", "text2sql.glossary.upsert", "text2sql.permission.upsert",
		"text2sql.schema.collect", "text2sql.connection.upsert", "text2sql.registry.import",
		"text2sql.profile.upsert", "text2sql.schema.upsert", "text2sql.schema.delete":
		return true
	default:
		return false
	}
}

func selectPostChangeRedTeamTargets(targets []store.RedTeamTarget, spec postChangeRedTeamSpec, limit int) []string {
	if limit <= 0 {
		return nil
	}
	targets = append([]store.RedTeamTarget(nil), targets...)
	sortPostChangeTargets(targets)
	eligible := make([]store.RedTeamTarget, 0, len(targets))
	for _, target := range targets {
		if !target.Enabled || !redTeamScopeMatches(spec.Scope, target.TargetType) {
			continue
		}
		if spec.Provider != "" && target.Provider != spec.Provider {
			continue
		}
		if spec.MCPUpstream != "" && target.MCPUpstream != spec.MCPUpstream {
			continue
		}
		if spec.ToolName != "" && target.ToolName != spec.ToolName {
			continue
		}
		if spec.TargetType != "" && target.TargetType != spec.TargetType {
			continue
		}
		if spec.TargetRef != "" && target.TargetRef != spec.TargetRef {
			continue
		}
		eligible = append(eligible, target)
	}
	// A deleted target no longer exists after inventory sync. In that case, test the remaining
	// targets in the same scope so fallback and policy behavior still receive a regression check.
	if len(eligible) == 0 && (spec.Provider != "" || spec.MCPUpstream != "" || spec.TargetRef != "") {
		fallback := spec
		fallback.Provider, fallback.MCPUpstream, fallback.ToolName, fallback.TargetRef = "", "", "", ""
		return selectPostChangeRedTeamTargets(targets, fallback, limit)
	}
	if len(eligible) <= limit {
		out := make([]string, 0, len(eligible))
		for _, target := range eligible {
			out = append(out, target.ID)
		}
		return out
	}

	// Round-robin target types so a broad governance/change-set trigger does not spend its
	// entire safety budget on the first alphabetic target category.
	groups := map[string][]store.RedTeamTarget{}
	for _, target := range eligible {
		groups[target.TargetType] = append(groups[target.TargetType], target)
	}
	order := []string{"provider", "model", "mcp_upstream", "mcp_tool", "text2sql", "ai_app", "workflow"}
	for kind := range groups {
		if !redTeamContains(order, kind) {
			order = append(order, kind)
		}
	}
	out := make([]string, 0, limit)
	for index := 0; len(out) < limit; index++ {
		added := false
		for _, kind := range order {
			if index < len(groups[kind]) {
				out = append(out, groups[kind][index].ID)
				added = true
				if len(out) == limit {
					break
				}
			}
		}
		if !added {
			break
		}
	}
	return out
}

func postChangeAuditMap(raw string) map[string]any {
	var out map[string]any
	if json.Unmarshal([]byte(strings.TrimSpace(raw)), &out) != nil || out == nil {
		return map[string]any{}
	}
	return out
}

func postChangeAuditString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := values[key]; ok {
			switch typed := value.(type) {
			case string:
				if strings.TrimSpace(typed) != "" {
					return strings.TrimSpace(typed)
				}
			case json.Number:
				return typed.String()
			case float64:
				return fmt.Sprintf("%v", typed)
			}
		}
	}
	return ""
}

func prefixedPostChangeRef(prefix, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, prefix) {
		return value
	}
	return prefix + value
}

func postChangeCampaignName(action, ref string) string {
	name := "변경 후 자동 점검 · " + strings.TrimSpace(action)
	if strings.TrimSpace(ref) != "" {
		name += " · " + strings.TrimSpace(ref)
	}
	runes := []rune(name)
	if len(runes) > 96 {
		name = string(runes[:96])
	}
	return name
}

// Keep campaign target selection deterministic even if a caller supplies inventory in an
// arbitrary order (store queries are sorted, unit tests and future adapters may not be).
func sortPostChangeTargets(targets []store.RedTeamTarget) {
	sort.SliceStable(targets, func(i, j int) bool {
		if targets[i].TargetType != targets[j].TargetType {
			return targets[i].TargetType < targets[j].TargetType
		}
		return targets[i].TargetRef < targets[j].TargetRef
	})
}
