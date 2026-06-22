package proxy

// gatewayToolContract is the published governance contract for one Gateway MCP tool: its risk
// level, cost policy, execution timeout, the roles allowed to call it, and the shape of its
// output. It formalizes /mcp/gateway as an official MCP server rather than an ad-hoc interface.
type gatewayToolContract struct {
	Name         string `json:"name"`
	RiskLevel    string `json:"risk_level"` // low | medium | high
	CostPolicy   string `json:"cost_policy"`
	TimeoutMS    int64  `json:"timeout_ms"`
	AllowedRoles string `json:"allowed_roles"` // empty = any authenticated caller (subject to scope)
	Executes     bool   `json:"executes"`      // true = performs a model/tool call; false = read-only
	OutputSchema string `json:"output_schema"` // short prose description of the result shape
}

// gatewayToolContracts is the canonical contract for every advertised gateway tool. A unit test
// asserts this set exactly covers gatewayToolDefs(), so adding a tool without a contract fails CI.
func gatewayToolContracts() []gatewayToolContract {
	return []gatewayToolContract{
		{"gateway_chat", "medium", "per_call_model_cost", 120000, "", true, "OpenAI chat.completion object"},
		{"gateway_run_skill", "medium", "per_call_model_cost", 120000, "", true, "OpenAI chat.completion object (skill applied)"},
		{"gateway_run_text2sql_preview", "low", "per_call_model_cost", 60000, "", true, "{sql_masked, schema, summary} — generated SQL preview, not executed"},
		{"gateway_run_saved_report", "low", "per_call_model_cost", 60000, "", true, "{report_id, summary} — saved report preview"},
		{"gateway_create_app_run", "medium", "per_component_cost", 120000, "", true, "{run_id, plan[]} — app component execution plan + run id"},
		{"gateway_run_workflow", "high", "per_step_cost", 300000, "", true, "{run_id, status, steps_ok, results[]} — sequential step results"},
		{"gateway_list_models", "low", "free", 10000, "", false, "{models[], pricing}"},
		{"gateway_estimate_cost", "low", "free", 5000, "", false, "{model, estimated_cost_krw}"},
		{"gateway_check_quota", "low", "free", 10000, "", false, "{allowed, used_krw, limit_krw, reason}"},
		{"gateway_route_preview", "low", "free", 10000, "", false, "{selected_model, provider, reason} — no execution"},
		{"gateway_list_skills", "low", "free", 10000, "", false, "{skills[]}"},
		{"gateway_explain_request", "low", "free", 10000, "", false, "{request_id, model, cost, routing, policy} — own request only"},
		{"gateway_get_usage_summary", "low", "free", 10000, "", false, "{window, requests, tokens, cost_krw}"},
	}
}
