package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

type secretPattern struct {
	typ         string
	re          *regexp.Regexp
	replacement string
}

type secretFinding struct {
	Type  string
	Value string
}

var secretFirewallPatterns = []secretPattern{
	{typ: "private_key", re: regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`), replacement: "[REDACTED_PRIVATE_KEY]"},
	{typ: "jwt", re: regexp.MustCompile(`eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}`), replacement: "[REDACTED_JWT]"},
	{typ: "openai_api_key", re: regexp.MustCompile(`sk-[A-Za-z0-9_\-]{16,}`), replacement: "[REDACTED_OPENAI_KEY]"},
	{typ: "anthropic_api_key", re: regexp.MustCompile(`sk-ant-[A-Za-z0-9_\-]{20,}`), replacement: "[REDACTED_ANTHROPIC_KEY]"},
	{typ: "vibe_api_key", re: regexp.MustCompile(`vc_(sk|sa)_[A-Za-z0-9_\-]{20,}`), replacement: "[REDACTED_VIBE_KEY]"},
	{typ: "aws_access_key", re: regexp.MustCompile(`AKIA[0-9A-Z]{16}`), replacement: "[REDACTED_AWS_ACCESS_KEY]"},
	{typ: "aws_secret", re: regexp.MustCompile(`(?i)(aws.{0,20}(secret|access).{0,20})[:=]\s*["']?[A-Za-z0-9/+=]{30,}`), replacement: "$1=[REDACTED]"},
	{typ: "db_connection_string", re: regexp.MustCompile(`(?i)\b(postgres|postgresql|mysql|mongodb|redis|mssql|sqlserver)://[^\s"'<>]+`), replacement: "[REDACTED_DB_CONNECTION]"},
	{typ: "access_token", re: regexp.MustCompile(`(?i)(access[_-]?token|refresh[_-]?token|bearer)\s*[:= ]\s*["']?[A-Za-z0-9._\-]{20,}`), replacement: "$1=[REDACTED]"},
	{typ: "password", re: regexp.MustCompile(`(?i)(password|passwd|pwd)\s*[:=]\s*["']?[^"',}\]\s]{6,}`), replacement: "$1=[REDACTED]"},
	{typ: "api_key", re: regexp.MustCompile(`(?i)(api[_-]?key|x-api-key|secret[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9._\-]{16,}`), replacement: "$1=[REDACTED]"},
}

type governanceContext struct {
	RequestID       string
	APIKeyID        string
	UserID          string
	TeamID          string
	TeamName        string
	Role            string
	Endpoint        string
	Phase           string
	Model           string
	Provider        string
	RiskScore       int
	ComplexityScore int
	CostKRW         float64
	ContainsSecret  bool
	SecretTypes     []string
	MCPServer       string
	MCPTool         string
	SubjectType     string
	SubjectID       string
}

type governanceDecision struct {
	Blocked         bool
	RequireApproval bool
	SecretAction    string
	Reason          string
	ApprovalID      string
	PolicyEvents    []store.PolicyDecisionEvent
}

func (s *Server) enforceOpenAIGovernance(w http.ResponseWriter, r *http.Request, meta *store.LogRecord, body []byte, authCtx *store.AuthContext, routingPlan *intelligentRoutingPlan, costKRW float64, detectSecrets bool, phase string) ([]byte, bool) {
	gctx := s.openAIGovernanceContext(r, meta, body, authCtx, routingPlan, costKRW, phase)
	findings := []secretFinding{}
	if detectSecrets {
		findings = detectSecretsInText(string(body))
		if len(findings) > 0 {
			gctx.ContainsSecret = true
			gctx.SecretTypes = findingTypes(findings)
		}
	}

	decision := s.evaluateGovernance(r, gctx)
	s.recordPolicyDecisionEvents(r.Context(), decision.PolicyEvents)
	action := strings.ToLower(strings.TrimSpace(decision.SecretAction))
	if action == "" {
		action = "detect"
	}
	if decision.Blocked && gctx.ContainsSecret {
		action = "block"
	}
	if len(findings) > 0 {
		s.recordSecretEvents(r, meta.Request.ID, action, authCtx, findings)
		w.Header().Set("X-Secret-Firewall", action)
		w.Header().Set("X-Secret-Firewall-Types", strings.Join(gctx.SecretTypes, ","))
		if action == "block" || action == "mask" {
			s.notifyMattermost(r.Context(), "secret", "Secret 탐지("+action+"): "+strings.Join(gctx.SecretTypes, ", ")+" (key "+meta.Request.APIKeyID+")")
		}
	}
	if action == "mask" && len(findings) > 0 {
		body = []byte(maskSecretText(string(body)))
	}
	if action == "block" && len(findings) > 0 {
		decision.Blocked = true
		if decision.Reason == "" {
			decision.Reason = "secret firewall blocked sensitive data"
		}
	}
	if decision.Blocked {
		s.writeGovernanceOpenAIBlock(w, meta, http.StatusForbidden, "governance_policy_error", "governance_blocked", firstNonEmpty(decision.Reason, "blocked by governance policy"))
		return body, true
	}
	if decision.RequireApproval {
		allowed, approvalID, reason := s.governanceApprovalGate(r, gctx, firstNonEmpty(decision.Reason, "approval required by governance policy"))
		if allowed {
			w.Header().Set("X-Governance-Approval-ID", approvalID)
			return body, false
		}
		w.Header().Set("X-Governance-Approval-ID", approvalID)
		decision.ApprovalID = approvalID
		s.notifyMattermost(r.Context(), "approval", "승인 대기: 요청 "+meta.Request.ID+" (key "+meta.Request.APIKeyID+", model "+gctx.Model+") — "+reason)
		s.writeGovernanceOpenAIBlock(w, meta, http.StatusLocked, "governance_approval_required", "approval_required", reason)
		return body, true
	}
	return body, false
}

func (s *Server) openAIGovernanceContext(r *http.Request, meta *store.LogRecord, body []byte, authCtx *store.AuthContext, routingPlan *intelligentRoutingPlan, costKRW float64, phase string) governanceContext {
	g := governanceContext{
		RequestID:   meta.Request.ID,
		APIKeyID:    meta.Request.APIKeyID,
		Endpoint:    meta.Request.Endpoint,
		Phase:       phase,
		Model:       meta.Request.Model,
		Provider:    meta.Request.Provider,
		CostKRW:     costKRW,
		SubjectType: "openai_request",
	}
	if authCtx != nil {
		g.UserID = authCtx.UserID
		g.TeamID = authCtx.TeamID
		g.TeamName = authCtx.TeamName
		g.Role = authCtx.Role
	}
	if routingPlan != nil {
		g.RiskScore = routingPlan.Risk.Score
		g.ComplexityScore = routingPlan.Complexity.Score
		if routingPlan.SelectedModel != "" {
			g.Model = routingPlan.SelectedModel
		}
		if routingPlan.SelectedProvider != "" {
			g.Provider = routingPlan.SelectedProvider
		}
	}
	g.SubjectID = audit.HashText(strings.Join([]string{g.APIKeyID, g.Endpoint, g.Model, g.Provider, string(body)}, "|"))[:24]
	return g
}

func (s *Server) evaluateGovernance(r *http.Request, g governanceContext) governanceDecision {
	rules, err := s.db.ActivePolicyRules(r.Context())
	if err != nil {
		return governanceDecision{SecretAction: "detect"}
	}
	return evaluatePolicyRules(rules, g)
}

// evaluatePolicyRules applies a rule set to one governance context and returns the
// resulting decision. Pure (no DB / request access) so the policy simulator can
// replay candidate rules against historical request contexts.
func evaluatePolicyRules(rules []store.PolicyRule, g governanceContext) governanceDecision {
	decision := governanceDecision{SecretAction: "detect"}
	reasons := []string{}
	for _, rule := range rules {
		if !governanceRuleMatches(rule.Conditions, g) {
			continue
		}
		actions := rule.Actions
		if action := lowerString(actions["secret_action"]); action == "detect" || action == "mask" || action == "block" {
			decision.SecretAction = action
			reason := "rule " + ruleName(rule) + " secret_action=" + action
			reasons = append(reasons, reason)
			decision.PolicyEvents = append(decision.PolicyEvents, policyDecisionEvent(g, rule, secretActionDecision(action), reason))
		}
		if model := strings.TrimSpace(g.Model); model != "" {
			if denied := valueStringList(actions["deny_models"]); len(denied) > 0 && listMatchesAny(model, denied) {
				decision.Blocked = true
				reason := "rule " + ruleName(rule) + " denied model " + model
				reasons = append(reasons, reason)
				decision.PolicyEvents = append(decision.PolicyEvents, policyDecisionEvent(g, rule, "deny_model", reason))
			}
			if allowed := valueStringList(actions["allow_models"]); len(allowed) > 0 && !listMatchesAny(model, allowed) {
				decision.Blocked = true
				reason := "rule " + ruleName(rule) + " did not allow model " + model
				reasons = append(reasons, reason)
				decision.PolicyEvents = append(decision.PolicyEvents, policyDecisionEvent(g, rule, "deny_model", reason))
			} else if len(allowed) > 0 {
				reason := "rule " + ruleName(rule) + " allowed model " + model
				reasons = append(reasons, reason)
				decision.PolicyEvents = append(decision.PolicyEvents, policyDecisionEvent(g, rule, "allow_model", reason))
			}
		}
		if provider := strings.TrimSpace(g.Provider); provider != "" {
			if denied := valueStringList(actions["deny_providers"]); len(denied) > 0 && listMatchesAny(provider, denied) {
				decision.Blocked = true
				reason := "rule " + ruleName(rule) + " denied provider " + provider
				reasons = append(reasons, reason)
				decision.PolicyEvents = append(decision.PolicyEvents, policyDecisionEvent(g, rule, "deny_provider", reason))
			}
			if allowed := valueStringList(actions["allow_providers"]); len(allowed) > 0 && !listMatchesAny(provider, allowed) {
				decision.Blocked = true
				reason := "rule " + ruleName(rule) + " did not allow provider " + provider
				reasons = append(reasons, reason)
				decision.PolicyEvents = append(decision.PolicyEvents, policyDecisionEvent(g, rule, "deny_provider", reason))
			} else if len(allowed) > 0 {
				reason := "rule " + ruleName(rule) + " allowed provider " + provider
				reasons = append(reasons, reason)
				decision.PolicyEvents = append(decision.PolicyEvents, policyDecisionEvent(g, rule, "allow_provider", reason))
			}
		}
		if boolAction(actions["block"]) {
			decision.Blocked = true
			reason := "rule " + ruleName(rule) + " requested block"
			reasons = append(reasons, reason)
			decision.PolicyEvents = append(decision.PolicyEvents, policyDecisionEvent(g, rule, "block", reason))
		}
		if boolAction(actions["require_approval"]) {
			decision.RequireApproval = true
			reason := "rule " + ruleName(rule) + " requested approval"
			reasons = append(reasons, reason)
			decision.PolicyEvents = append(decision.PolicyEvents, policyDecisionEvent(g, rule, "require_approval", reason))
		}
		if boolAction(actions["allow"]) {
			reason := "rule " + ruleName(rule) + " requested allow"
			reasons = append(reasons, reason)
			decision.PolicyEvents = append(decision.PolicyEvents, policyDecisionEvent(g, rule, "allow", reason))
		}
	}
	if decision.Blocked {
		decision.RequireApproval = false
	}
	if len(reasons) > 0 {
		decision.Reason = strings.Join(reasons, "; ")
	}
	if len(decision.PolicyEvents) == 0 {
		decision.PolicyEvents = append(decision.PolicyEvents, defaultPolicyDecisionEvent(g))
	}
	return decision
}

func policyDecisionEvent(g governanceContext, rule store.PolicyRule, decision, reason string) store.PolicyDecisionEvent {
	return store.PolicyDecisionEvent{
		RequestID:       g.RequestID,
		APIKeyID:        g.APIKeyID,
		UserID:          g.UserID,
		TeamID:          g.TeamID,
		Endpoint:        g.Endpoint,
		Phase:           firstNonEmpty(g.Phase, "request"),
		PolicyID:        rule.PolicyID,
		RuleID:          rule.ID,
		RuleName:        ruleName(rule),
		Decision:        decision,
		Reason:          reason,
		Model:           g.Model,
		Provider:        g.Provider,
		RiskScore:       g.RiskScore,
		ComplexityScore: g.ComplexityScore,
		CostKRW:         g.CostKRW,
	}
}

func defaultPolicyDecisionEvent(g governanceContext) store.PolicyDecisionEvent {
	return store.PolicyDecisionEvent{
		RequestID:       g.RequestID,
		APIKeyID:        g.APIKeyID,
		UserID:          g.UserID,
		TeamID:          g.TeamID,
		Endpoint:        g.Endpoint,
		Phase:           firstNonEmpty(g.Phase, "request"),
		PolicyID:        "default",
		RuleID:          "default",
		RuleName:        "DEFAULT",
		Decision:        "default",
		Reason:          "no governance policy matched; default allow",
		Model:           g.Model,
		Provider:        g.Provider,
		RiskScore:       g.RiskScore,
		ComplexityScore: g.ComplexityScore,
		CostKRW:         g.CostKRW,
	}
}

func secretActionDecision(action string) string {
	switch action {
	case "mask":
		return "mask"
	case "block":
		return "block"
	default:
		return "detect"
	}
}

func (s *Server) recordPolicyDecisionEvents(ctx context.Context, events []store.PolicyDecisionEvent) {
	stored := events[:0]
	for _, event := range events {
		if strings.TrimSpace(event.Decision) == "" {
			continue
		}
		if event.ID == "" {
			event.ID = newID("pde")
		}
		if event.CreatedAt.IsZero() {
			event.CreatedAt = time.Now().UTC()
		}
		_ = s.db.InsertPolicyDecisionEvent(ctx, event)
		stored = append(stored, event)
	}
	s.emitPolicyFacts(stored) // best-effort DW fact (no-op unless configured)
}

func governanceRuleMatches(conditions map[string]any, g governanceContext) bool {
	if len(conditions) == 0 {
		return true
	}
	for key, expected := range conditions {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "user", "user_id":
			if !matchStringCondition(g.UserID, expected) {
				return false
			}
		case "team":
			if !matchAnyStringCondition([]string{g.TeamID, g.TeamName}, expected) {
				return false
			}
		case "team_id":
			if !matchStringCondition(g.TeamID, expected) {
				return false
			}
		case "team_name":
			if !matchStringCondition(g.TeamName, expected) {
				return false
			}
		case "role":
			if !matchStringCondition(g.Role, expected) {
				return false
			}
		case "model":
			if !matchStringCondition(g.Model, expected) {
				return false
			}
		case "provider":
			if !matchStringCondition(g.Provider, expected) {
				return false
			}
		case "endpoint":
			if !matchStringCondition(g.Endpoint, expected) {
				return false
			}
		case "risk_score":
			if !numberCondition(float64(g.RiskScore), expected) {
				return false
			}
		case "complexity_score":
			if !numberCondition(float64(g.ComplexityScore), expected) {
				return false
			}
		case "cost", "cost_krw":
			if g.CostKRW <= 0 || !numberCondition(g.CostKRW, expected) {
				return false
			}
		case "contains_secret":
			if !boolCondition(g.ContainsSecret, expected) {
				return false
			}
		case "secret_type":
			if !listIntersects(g.SecretTypes, valueStringList(expected)) {
				return false
			}
		case "mcp_server":
			if !matchStringCondition(g.MCPServer, expected) {
				return false
			}
		case "mcp_tool":
			if !matchStringCondition(g.MCPTool, expected) {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func detectSecretsInText(text string) []secretFinding {
	seen := map[string]bool{}
	findings := []secretFinding{}
	for _, p := range secretFirewallPatterns {
		for _, match := range p.re.FindAllString(text, 20) {
			if strings.TrimSpace(match) == "" {
				continue
			}
			key := p.typ + ":" + audit.HashText(match)
			if seen[key] {
				continue
			}
			seen[key] = true
			findings = append(findings, secretFinding{Type: p.typ, Value: match})
			if len(findings) >= 50 {
				return findings
			}
		}
	}
	return findings
}

func maskSecretText(text string) string {
	masked := audit.Redact(text)
	for _, p := range secretFirewallPatterns {
		if p.replacement != "" {
			masked = p.re.ReplaceAllString(masked, p.replacement)
		}
	}
	return masked
}

func findingTypes(findings []secretFinding) []string {
	seen := map[string]bool{}
	types := []string{}
	for _, f := range findings {
		if f.Type == "" || seen[f.Type] {
			continue
		}
		seen[f.Type] = true
		types = append(types, f.Type)
	}
	return types
}

func (s *Server) recordSecretEvents(r *http.Request, requestID, action string, authCtx *store.AuthContext, findings []secretFinding) {
	for _, f := range findings {
		e := store.SecretEvent{
			ID:          newID("sec"),
			RequestID:   requestID,
			SecretType:  f.Type,
			Action:      action,
			Location:    "request_body",
			MatchedHash: audit.HashText(f.Value),
			CreatedAt:   time.Now().UTC(),
		}
		if authCtx != nil {
			e.APIKeyID = authCtx.APIKeyID
			e.UserID = authCtx.UserID
			e.TeamID = authCtx.TeamID
		}
		if e.APIKeyID == "" {
			e.APIKeyID = "anonymous"
		}
		_ = s.db.InsertSecretEvent(r.Context(), e)
	}
}

func (s *Server) writeGovernanceOpenAIBlock(w http.ResponseWriter, meta *store.LogRecord, status int, typ, code, message string) {
	meta.Request.StatusCode = status
	meta.Request.Provider = firstNonEmpty(meta.Request.Provider, "blocked")
	meta.Request.Error = message
	s.enqueue(*meta)
	writeOpenAIError(w, status, message, typ, code)
}

func (s *Server) governanceApprovalGate(r *http.Request, g governanceContext, reason string) (bool, string, string) {
	headerID := strings.TrimSpace(r.Header.Get("X-Governance-Approval-ID"))
	now := time.Now().UTC()
	if headerID != "" {
		_, _ = s.db.ExpireApprovals(r.Context(), now)
		approval, found, err := s.db.GetApproval(r.Context(), headerID)
		if err != nil || !found {
			return false, headerID, "approval id is invalid or not found"
		}
		if approval.Status == "pending" && !approval.ExpiresAt.IsZero() && approval.ExpiresAt.Before(now) {
			_ = s.db.SetApprovalStatus(r.Context(), approval.ID, "expired", "system")
			return false, approval.ID, "approval expired"
		}
		if approval.Status != "approved" {
			return false, approval.ID, "approval status is " + approval.Status
		}
		if !approval.ExpiresAt.IsZero() && approval.ExpiresAt.Before(now) {
			return false, approval.ID, "approval expired"
		}
		if approval.SubjectType != "" && approval.SubjectType != g.SubjectType {
			return false, approval.ID, "approval subject type does not match this request"
		}
		if approval.APIKeyID != "" && g.APIKeyID != "" && approval.APIKeyID != g.APIKeyID {
			return false, approval.ID, "approval api key does not match this request"
		}
		if approval.UserID != "" && g.UserID != "" && approval.UserID != g.UserID {
			return false, approval.ID, "approval user does not match this request"
		}
		if approval.TeamID != "" && g.TeamID != "" && approval.TeamID != g.TeamID {
			return false, approval.ID, "approval team does not match this request"
		}
		if approval.SubjectID != "" && approval.SubjectID != g.SubjectID {
			return false, approval.ID, "approval subject does not match this request"
		}
		return true, approval.ID, ""
	}
	payload := auditJSON(map[string]any{
		"endpoint":         g.Endpoint,
		"model":            g.Model,
		"provider":         g.Provider,
		"risk_score":       g.RiskScore,
		"complexity_score": g.ComplexityScore,
		"cost_krw":         g.CostKRW,
		"contains_secret":  g.ContainsSecret,
		"secret_types":     g.SecretTypes,
		"mcp_server":       g.MCPServer,
		"mcp_tool":         g.MCPTool,
	})
	approval := store.Approval{
		ID:          newID("appr"),
		RequestID:   g.RequestID,
		APIKeyID:    g.APIKeyID,
		UserID:      g.UserID,
		TeamID:      g.TeamID,
		SubjectType: g.SubjectType,
		SubjectID:   g.SubjectID,
		Status:      "pending",
		Reason:      reason,
		RiskScore:   g.RiskScore,
		CostKRW:     g.CostKRW,
		Payload:     payload,
		ExpiresAt:   now.Add(24 * time.Hour),
		CreatedAt:   now,
	}
	_ = s.db.InsertApproval(r.Context(), approval)
	return false, approval.ID, "approval required: " + reason
}

func (s *Server) enforceMCPToolGovernance(r *http.Request, apiKeyID string, authCtx *store.AuthContext, route mcpRoute, method, exposedName, toolName string, args json.RawMessage, id json.RawMessage) *rpcResponse {
	profile, found, err := s.db.ToolRiskProfile(r.Context(), route.upstreamName, toolName)
	if err != nil {
		return nil
	}
	riskLevel, action := inferMCPRisk(route.upstreamName, toolName)
	note := ""
	if found {
		riskLevel = normalizeRiskLevel(profile.RiskLevel, riskLevel)
		action = normalizeToolRiskAction(profile.Action, action)
		note = profile.Note
	}
	g := governanceContext{
		APIKeyID:    apiKeyID,
		Endpoint:    "/mcp",
		Phase:       "mcp_tool",
		Model:       "mcp:" + route.upstreamName,
		Provider:    route.upstreamName,
		RiskScore:   riskLevelScore(riskLevel),
		MCPServer:   route.upstreamName,
		MCPTool:     toolName,
		SubjectType: "mcp_tool",
		SubjectID:   audit.HashText(strings.Join([]string{apiKeyID, route.upstreamName, toolName, string(args)}, "|"))[:24],
	}
	if authCtx != nil {
		g.UserID = authCtx.UserID
		g.TeamID = authCtx.TeamID
		g.TeamName = authCtx.TeamName
		g.Role = authCtx.Role
	}
	if findings := detectSecretsInText(string(args)); len(findings) > 0 {
		g.ContainsSecret = true
		g.SecretTypes = findingTypes(findings)
		s.recordSecretEvents(r, "", "detect", authCtx, findings)
	}
	decision := s.evaluateGovernance(r, g)
	if action == "block" {
		decision.Blocked = true
		decision.Reason = firstNonEmpty(note, "MCP tool risk profile blocked "+route.upstreamName+"/"+toolName)
		decision.PolicyEvents = append(decision.PolicyEvents, toolRiskDecisionEvent(g, profile, found, "block", decision.Reason))
	}
	if action == "require_approval" {
		decision.RequireApproval = true
		if decision.Reason == "" {
			decision.Reason = firstNonEmpty(note, "MCP tool risk profile requires approval "+route.upstreamName+"/"+toolName)
		}
		decision.PolicyEvents = append(decision.PolicyEvents, toolRiskDecisionEvent(g, profile, found, "require_approval", decision.Reason))
	}
	if decision.Blocked {
		s.metrics.IncMCPBlocked()
		reqID := s.logMCPCall(r, apiKeyID, route.upstreamName, toolName, args, true, http.StatusForbidden, 0)
		s.recordMCPRouteDecision(r, reqID, apiKeyID, method, exposedName, route, "block", firstNonEmpty(decision.Reason, "mcp_tool_blocked"), 0)
		s.recordPolicyDecisionEvents(r.Context(), withPolicyDecisionRequestID(decision.PolicyEvents, reqID))
		return rpcErrorResponse(id, -32000, "blocked by governance policy: "+firstNonEmpty(decision.Reason, "mcp_tool_blocked"))
	}
	if decision.RequireApproval {
		allowed, approvalID, reason := s.governanceApprovalGate(r, g, firstNonEmpty(decision.Reason, "MCP tool approval required"))
		if allowed {
			s.recordPolicyDecisionEvents(r.Context(), decision.PolicyEvents)
			return nil
		}
		reqID := s.logMCPCall(r, apiKeyID, route.upstreamName, toolName, args, true, http.StatusLocked, 0)
		s.recordMCPRouteDecision(r, reqID, apiKeyID, method, exposedName, route, "approval_required", reason, 0)
		s.recordPolicyDecisionEvents(r.Context(), withPolicyDecisionRequestID(decision.PolicyEvents, reqID))
		return rpcErrorResponse(id, -32000, "approval required: "+reason+"; approval_id="+approvalID)
	}
	s.recordPolicyDecisionEvents(r.Context(), decision.PolicyEvents)
	return nil
}

func toolRiskDecisionEvent(g governanceContext, profile store.ToolRiskProfile, found bool, decision, reason string) store.PolicyDecisionEvent {
	policyID := "tool_risk_profile"
	ruleID := g.MCPServer + "/" + g.MCPTool
	ruleName := ruleID
	if found {
		ruleID = profile.ID
		ruleName = profile.ServerLabel + "/" + profile.ToolName
	}
	return store.PolicyDecisionEvent{
		RequestID:       g.RequestID,
		APIKeyID:        g.APIKeyID,
		UserID:          g.UserID,
		TeamID:          g.TeamID,
		Endpoint:        g.Endpoint,
		Phase:           firstNonEmpty(g.Phase, "mcp_tool"),
		PolicyID:        policyID,
		RuleID:          ruleID,
		RuleName:        ruleName,
		Decision:        decision,
		Reason:          reason,
		Model:           g.Model,
		Provider:        g.Provider,
		RiskScore:       g.RiskScore,
		ComplexityScore: g.ComplexityScore,
		CostKRW:         g.CostKRW,
	}
}

func withPolicyDecisionRequestID(events []store.PolicyDecisionEvent, requestID string) []store.PolicyDecisionEvent {
	for i := range events {
		if events[i].RequestID == "" {
			events[i].RequestID = requestID
		}
	}
	return events
}

func inferMCPRisk(server, tool string) (string, string) {
	level, _ := accessClassDefaults(inferToolAccessClass(server, tool))
	return level, "allow"
}

// inferToolAccessClass grades an MCP tool into one of five access tiers by name:
// secret > execute > network > write > read (most-sensitive first). This is the
// dimension the roadmap calls for — read/write/execute/network/secret — which
// then maps to a default risk level and a recommended policy action.
func inferToolAccessClass(server, tool string) string {
	lower := strings.ToLower(server + " " + tool)
	contains := func(words ...string) bool {
		for _, w := range words {
			if strings.Contains(lower, w) {
				return true
			}
		}
		return false
	}
	switch {
	case contains("secret", "credential", "password", "vault", "apikey", "api_key", "access key", "access_key", "token", "private key", "private_key", "env var", "환경 변수", "비밀"):
		return "secret"
	case contains("shell", "exec", "bash", "powershell", "terminal", "command", "run_", "kubectl", "terraform", "docker", "deploy", "ssh", "systemctl", "sudo"):
		return "execute"
	case contains("http", "fetch", "request", "curl", "url", "web", "browse", "download", "upload", "webhook", "email", "send_", "smtp", "network", "socket"):
		return "network"
	case contains("write", "create", "update", "delete", "remove", "put", "post", "commit", "push", "mkdir", "edit", "modify", "insert", "drop", "migrate", "save", "rename", "db_", "database", "sql", "git"):
		return "write"
	default:
		return "read"
	}
}

// accessClassDefaults maps an access class to its default risk level and the
// recommended policy action (connecting grading to policy/approval). Execute and
// secret tiers default to requiring approval; network is high but advisory.
func accessClassDefaults(class string) (level, recommendedAction string) {
	switch class {
	case "secret":
		return "critical", "require_approval"
	case "execute":
		return "critical", "require_approval"
	case "network":
		return "high", "require_approval"
	case "write":
		return "medium", "allow"
	default:
		return "low", "allow"
	}
}

func riskLevelScore(level string) int {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "critical":
		return 95
	case "high":
		return 75
	case "medium":
		return 50
	default:
		return 20
	}
}

func normalizeRiskLevel(value, fallback string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low", "medium", "high", "critical":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return fallback
	}
}

func normalizeToolRiskAction(value, fallback string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "allow", "block", "require_approval":
		return strings.ToLower(strings.TrimSpace(value))
	case "approval", "approve":
		return "require_approval"
	default:
		return fallback
	}
}

func ruleName(rule store.PolicyRule) string {
	if strings.TrimSpace(rule.Name) != "" {
		return rule.Name
	}
	return rule.ID
}

func boolAction(value any) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(strings.TrimSpace(v), "true") || strings.EqualFold(strings.TrimSpace(v), "yes") || strings.TrimSpace(v) == "1"
	case float64:
		return v != 0
	case int:
		return v != 0
	default:
		return false
	}
}

func boolCondition(actual bool, expected any) bool {
	switch v := expected.(type) {
	case bool:
		return actual == v
	case string:
		return actual == boolAction(v)
	default:
		return actual == boolAction(v)
	}
}

func lowerString(value any) string {
	if raw, ok := value.(string); ok {
		return strings.ToLower(strings.TrimSpace(raw))
	}
	return ""
}

func matchStringCondition(actual string, expected any) bool {
	actual = strings.TrimSpace(actual)
	if actual == "" {
		return false
	}
	values := valueStringList(expected)
	if len(values) == 0 {
		return false
	}
	return listMatchesAny(actual, values)
}

func matchAnyStringCondition(actuals []string, expected any) bool {
	for _, actual := range actuals {
		if matchStringCondition(actual, expected) {
			return true
		}
	}
	return false
}

func listMatchesAny(actual string, patterns []string) bool {
	actual = strings.ToLower(strings.TrimSpace(actual))
	for _, pattern := range patterns {
		pattern = strings.ToLower(strings.TrimSpace(pattern))
		if pattern == "" {
			continue
		}
		if matchGlob(pattern, actual) {
			return true
		}
	}
	return false
}

func listIntersects(actual, expected []string) bool {
	if len(expected) == 0 {
		return false
	}
	for _, a := range actual {
		if listMatchesAny(a, expected) {
			return true
		}
	}
	return false
}

func valueStringList(value any) []string {
	switch v := value.(type) {
	case []string:
		return v
	case []any:
		out := []string{}
		for _, item := range v {
			if s := strings.TrimSpace(toString(item)); s != "" {
				out = append(out, s)
			}
		}
		return out
	case string:
		if strings.Contains(v, ",") {
			parts := strings.Split(v, ",")
			out := []string{}
			for _, p := range parts {
				if p = strings.TrimSpace(p); p != "" {
					out = append(out, p)
				}
			}
			return out
		}
		if strings.TrimSpace(v) == "" {
			return nil
		}
		return []string{strings.TrimSpace(v)}
	default:
		if s := strings.TrimSpace(toString(value)); s != "" {
			return []string{s}
		}
		return nil
	}
}

func toString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int:
		return strconv.Itoa(v)
	case bool:
		if v {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

func numberCondition(actual float64, expected any) bool {
	switch v := expected.(type) {
	case float64:
		return actual >= v
	case int:
		return actual >= float64(v)
	case json.Number:
		if f, err := v.Float64(); err == nil {
			return actual >= f
		}
	case string:
		return compareNumberExpression(actual, v)
	}
	return false
}

func compareNumberExpression(actual float64, expr string) bool {
	expr = strings.TrimSpace(expr)
	ops := []string{">=", "<=", "==", "!=", ">", "<"}
	for _, op := range ops {
		if strings.HasPrefix(expr, op) {
			n, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimPrefix(expr, op)), 64)
			if err != nil {
				return false
			}
			switch op {
			case ">=":
				return actual >= n
			case "<=":
				return actual <= n
			case "==":
				return actual == n
			case "!=":
				return actual != n
			case ">":
				return actual > n
			case "<":
				return actual < n
			}
		}
	}
	n, err := strconv.ParseFloat(expr, 64)
	return err == nil && actual >= n
}
