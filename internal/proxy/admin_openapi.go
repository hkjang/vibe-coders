package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
)

// apiEndpoint is one documented route: its path, the HTTP methods it serves, an OpenAPI tag,
// a one-line summary, and whether it is public (no auth). Prefix handlers registered with a
// trailing slash are written here with an explicit path parameter (e.g. .../{id}).
type apiEndpoint struct {
	path    string
	methods []string
	tag     string
	summary string
	public  bool
}

// apiEndpoints is the comprehensive catalog of the gateway's HTTP surface, kept in sync with
// the route registrations in Routes(). It drives the generated /openapi.json so the spec
// covers every endpoint rather than a curated subset.
var apiEndpoints = []apiEndpoint{
	// ---- ops / docs (public) ----
	{"/health", []string{"get"}, "ops", "Liveness probe", true},
	{"/ready", []string{"get"}, "ops", "Readiness probe", true},
	{"/metrics", []string{"get"}, "ops", "Prometheus metrics", true},
	{"/openapi.json", []string{"get"}, "ops", "This OpenAPI document", true},
	{"/swagger", []string{"get"}, "ops", "Swagger UI", true},
	{"/favicon.ico", []string{"get"}, "ops", "Favicon", true},

	// ---- inference (OpenAI-compatible) ----
	{"/v1/chat/completions", []string{"post"}, "inference", "Chat completions (SSE streaming + vibe/text2sql-* virtual models)", false},
	{"/v1/models", []string{"get"}, "inference", "List models", false},
	{"/v1/embeddings", []string{"post"}, "inference", "Embeddings", false},

	// ---- MCP / VCS ----
	{"/mcp", []string{"post"}, "mcp", "MCP gateway (JSON-RPC passthrough)", false},
	{"/mcp/gateway", []string{"post"}, "mcp", "AI Gateway MCP Server — vibe-coders' own features as MCP tools/resources/prompts", false},
	{"/admin/gateway-mcp/info", []string{"get"}, "mcp", "Gateway MCP catalog (tools/resources/prompts) for the admin UI", false},
	{"/admin/mcp/gateway/test", []string{"post"}, "mcp", "Admin: invoke a Gateway MCP tool by name to verify it", false},
	{"/admin/mcp/contracts", []string{"get", "post", "delete"}, "mcp", "MCP Tool Contract Registry: list/upsert/delete tool contracts", false},
	{"/admin/mcp/contracts/validate", []string{"post"}, "mcp", "Detect drift between registered MCP tool contracts and live gateway tools", false},
	{"/vcs/events", []string{"post"}, "vcs", "VCS webhook ingest", true},
	{"/vcs/webhook/{provider}", []string{"post"}, "vcs", "VCS webhook ingest (provider path)", true},

	// ---- auth ----
	{"/auth/login", []string{"post"}, "auth", "Log in (email/password) → access+refresh tokens", true},
	{"/auth/logout", []string{"post"}, "auth", "Log out (revoke refresh token)", true},
	{"/auth/refresh", []string{"post"}, "auth", "Exchange refresh token for a new access token", true},
	{"/auth/me", []string{"get"}, "auth", "Current identity, gateway version, session expiry", false},

	// ---- self-service (/me) ----
	{"/me/dashboard", []string{"get"}, "self-service", "Caller's personal usage dashboard", false},
	{"/me/recommendations", []string{"get"}, "self-service", "Caller's personalized recommendations", false},
	{"/me/recommendations/feedback", []string{"post"}, "self-service", "Record accepted/rejected/later feedback on a recommendation", false},
	{"/me/recommendations/{id}/feedback", []string{"post"}, "self-service", "Record accepted/rejected/later feedback on a recommendation", false},
	{"/me/keys", []string{"get", "post"}, "self-service", "List / issue the caller's own API keys", false},
	{"/me/keys/{id}", []string{"post", "delete"}, "self-service", "Rotate ({id}/rotate) or revoke the caller's key", false},
	{"/team/portal", []string{"get"}, "self-service", "Team self-service portal (usage/budget/keys/skills/members)", false},
	{"/me/data-products", []string{"get"}, "self-service", "Browse published data products visible to the caller's team", false},
	{"/me/data-products/{key}/request-access", []string{"post"}, "self-service", "Request access to a data product", false},
	{"/me/onboarding-pack", []string{"get"}, "self-service", "Client connection pack (?client=mcp|cursor|roo|cline|openai-sdk)", false},
	{"/me/connection-doctor", []string{"post"}, "self-service", "Diagnose client connection setup (auth/scope/model/quota/v1/mcp); body {client}", false},
	{"/me/app-runs", []string{"get"}, "self-service", "Caller's AI work-app run history (?app_id=&limit=)", false},
	{"/v1/app-runs/{run_id}/receipt", []string{"get"}, "self-service", "Safe receipt for an AI app run", false},
	{"/v1/workflow-runs/{run_id}/receipt", []string{"get"}, "self-service", "Safe receipt for a workflow run", false},
	{"/me/requests", []string{"get"}, "self-service", "List the caller's recent requests (safe metadata)", false},
	{"/me/requests/{id}/receipt", []string{"get"}, "self-service", "Safe receipt for one of the caller's requests (no raw prompt/SQL)", false},

	// ---- admin UI ----
	{"/admin", []string{"get"}, "admin", "Admin dashboard (HTML)", false},

	// ---- admin: core analytics ----
	{"/admin/stats", []string{"get"}, "admin", "Summary stats", false},
	{"/admin/requests", []string{"get"}, "admin", "List recent requests", false},
	{"/admin/requests/{id}", []string{"get"}, "admin", "Request detail with readable OpenAI-compatible model/params/header/routing projection", false},
	{"/admin/requests/{id}/headers", []string{"get"}, "admin", "Masked and grouped request/gateway/upstream headers", false},
	{"/admin/requests/{id}/routing", []string{"get"}, "admin", "Routing, provider, fallback, policy and model resolution summary", false},
	{"/admin/requests/{id}/body", []string{"get"}, "admin", "Masked request body summary and raw body evidence when retained", false},
	{"/admin/requests/{id}/timeline", []string{"get"}, "admin", "Request processing timeline with spans/tool/Text2SQL overlays", false},
	{"/admin/requests/{id}/export", []string{"post"}, "admin", "Masked request evidence export (?format=json|markdown)", false},
	{"/admin/requests/{id}/links", []string{"get"}, "admin", "Request trace links across routing/MCP/Text2SQL/governance", false},
	{"/admin/requests/{id}/trace", []string{"get"}, "admin", "Unified request waterfall (root + MCP/tool + Text2SQL spans)", false},
	{"/admin/traces/{trace_id}", []string{"get"}, "admin", "All requests + workflow/app runs sharing a trace_id", false},
	{"/admin/code-verify", []string{"post"}, "admin", "Static verification gate for AI-generated code blocks (risk/secret/syntax)", false},
	{"/admin/code-verify/stats", []string{"get"}, "admin", "Per-model code risk leaderboard from persisted verdicts", false},
	{"/admin/sbom", []string{"get"}, "admin", "AI asset SBOM: ownership/dependency manifest across skills/workflows/apps/contracts/prompts", false},
	{"/admin/journey-probe", []string{"post"}, "admin", "Per-dev-tool synthetic connection journey probe (models/MCP) with a supplied key", false},
	{"/admin/pods", []string{"get"}, "admin", "Multi-pod operations map: per-pod heartbeat, build, settings convergence", false},
	{"/admin/privacy-ledger", []string{"get"}, "admin", "Privacy/data-egress ledger by team/model/provider (detect/mask/block + egress); ?format=csv for export", false},
	{"/admin/productivity", []string{"get"}, "admin", "AI usage vs delivery (VCS commits/MRs) correlation per repo", false},
	{"/admin/apps/onboarding-check", []string{"post"}, "admin", "Pre-publish onboarding readiness checklist for an AI app draft", false},
	{"/admin/mcp/onboarding-check", []string{"post"}, "admin", "Pre-register onboarding readiness checklist for an MCP upstream draft", false},
	{"/admin/sessions", []string{"get"}, "admin", "Recent coding sessions (flight-recorder index)", false},
	{"/admin/sessions/{session_id}/flight-recorder", []string{"get"}, "admin", "Chronological flight recorder for one agent session", false},
	{"/admin/requests/diff", []string{"get"}, "admin", "Diff two requests", false},
	{"/admin/prompts", []string{"get"}, "admin", "Search prompts", false},
	{"/admin/timeseries", []string{"get"}, "admin", "Usage timeseries", false},
	{"/admin/heatmap", []string{"get"}, "admin", "Activity heatmap", false},
	{"/admin/scatter", []string{"get"}, "admin", "XView scatter data", false},
	{"/admin/waterfall", []string{"get"}, "admin", "Request waterfall", false},
	{"/admin/anomalies", []string{"get"}, "admin", "Request anomalies", false},
	{"/admin/incidents", []string{"get"}, "admin", "Incidents", false},
	{"/admin/incidents/candidates", []string{"get"}, "admin", "Incident candidates (Incident Copilot)", false},
	{"/admin/sandbox/preview", []string{"post"}, "admin", "Sensitive-workflow sandbox preview (safety gates, no execution)", false},
	{"/admin/remediation/playbooks", []string{"get"}, "admin", "Auto-remediation action candidates (dry-run/impact)", false},
	{"/admin/remediation/apply", []string{"post"}, "admin", "Apply an approved reversible remediation action (audited, rollback)", false},
	{"/admin/redteam/dashboard", []string{"get"}, "redteam", "Red Team dashboard: risk rollup, target×pack result matrix, top failing targets, baseline drift", false},
	{"/admin/redteam/targets", []string{"get"}, "redteam", "Red Team target inventory collected from registered providers/MCP/Text2SQL/apps/workflows", false},
	{"/admin/redteam/targets/{id}", []string{"get"}, "redteam", "Red Team target detail", false},
	{"/admin/redteam/probe-packs", []string{"get", "post"}, "redteam", "Red Team probe pack registry", false},
	{"/admin/redteam/campaigns", []string{"get", "post"}, "redteam", "Red Team campaign builder/list", false},
	{"/admin/redteam/campaigns/{id}", []string{"get"}, "redteam", "Red Team campaign detail", false},
	{"/admin/redteam/campaigns/{id}/dry-run", []string{"post"}, "redteam", "Red Team dry-run preview without upstream calls", false},
	{"/admin/redteam/campaigns/{id}/approve", []string{"post"}, "redteam", "Approve a high-risk Red Team campaign", false},
	{"/admin/redteam/campaigns/{id}/run", []string{"post"}, "redteam", "Run a controlled Red Team campaign", false},
	{"/admin/redteam/runs", []string{"get"}, "redteam", "Red Team run history", false},
	{"/admin/redteam/runs/{id}", []string{"get"}, "redteam", "Red Team run detail", false},
	{"/admin/redteam/runs/{id}/results", []string{"get"}, "redteam", "Red Team case results for a run", false},
	{"/admin/redteam/results/{id}/evidence", []string{"get"}, "redteam", "Masked Red Team evidence", false},
	{"/admin/redteam/results/{id}/remediation", []string{"post"}, "redteam", "Create a Red Team remediation action", false},
	{"/admin/redteam/remediations", []string{"get"}, "redteam", "List Red Team remediation actions", false},
	{"/admin/redteam/schedules", []string{"get", "post"}, "redteam", "Red Team schedule definitions", false},
	{"/admin/redteam/baselines", []string{"get"}, "redteam", "Red Team baselines and drift anchors", false},
	{"/admin/redteam/export", []string{"post"}, "redteam", "Masked Red Team report export", false},
	{"/admin/suggest", []string{"get"}, "admin", "Autocomplete suggestions", false},
	{"/admin/export.csv", []string{"get"}, "admin", "Export request history (CSV)", false},
	{"/admin/contexts", []string{"get"}, "admin", "RAG/KB contexts", false},

	// ---- admin: identity ----
	{"/admin/users", []string{"get", "post"}, "admin", "List users / create auth user", false},
	{"/admin/users/{id}", []string{"get", "patch"}, "admin", "User detail / update; {id}/report for weekly report", false},
	{"/admin/teams", []string{"get", "post"}, "admin", "List / create teams", false},
	{"/admin/teams/scorecard", []string{"get"}, "admin", "Per-team AI maturity scorecard (?window=&format=csv)", false},
	{"/admin/reports/narrative", []string{"get"}, "admin", "Monthly narrative operations report (?window=&format=md)", false},
	{"/admin/teams/{team}", []string{"get"}, "admin", "Team detail", false},
	{"/admin/ips", []string{"get"}, "admin", "List client IPs", false},
	{"/admin/ips/{ip}", []string{"get"}, "admin", "IP detail", false},
	{"/admin/api-keys", []string{"get", "post"}, "admin", "List / create API keys", false},
	{"/admin/api-keys/{id}", []string{"get", "patch", "delete"}, "admin", "API key detail / update / revoke ({id}/revoke)", false},
	{"/admin/keys/health", []string{"get"}, "admin", "API key hygiene alerts (expiring/idle)", false},
	{"/admin/providers", []string{"get", "post"}, "admin", "List / upsert providers", false},
	{"/admin/providers/{name}", []string{"get", "put", "delete"}, "admin", "Provider detail / update / delete", false},
	{"/admin/providers/slo", []string{"get"}, "admin", "Provider SLOs", false},
	{"/admin/chat-test/targets", []string{"get"}, "admin", "List Chat Completions test targets across routing, providers, Text2SQL, and MCP", false},
	{"/admin/chat-test/run", []string{"post"}, "admin", "Run a real /v1/chat/completions test through the gateway pipeline", false},

	// ---- admin: audit ----
	{"/admin/audit-logs", []string{"get"}, "admin", "Admin audit logs", false},
	{"/admin/audit-logs.csv", []string{"get"}, "admin", "Admin audit logs (CSV)", false},
	{"/admin/audit/auth-events", []string{"get"}, "admin", "Auth events", false},
	{"/admin/audit/anomalies", []string{"get"}, "admin", "Admin audit anomaly detection", false},

	// ---- admin: quotas / retention / fallback ----
	{"/admin/quotas", []string{"get", "post"}, "admin", "List / create quotas", false},
	{"/admin/quotas/{id}", []string{"put", "delete"}, "admin", "Update / delete a quota", false},
	{"/admin/retention", []string{"get", "post"}, "admin", "Retention policy", false},
	{"/admin/fallback", []string{"get", "post"}, "admin", "Fallback config", false},
	{"/admin/kill-switch", []string{"get", "post"}, "admin", "Global kill switch", false},

	// ---- admin: settings ----
	{"/admin/settings", []string{"get"}, "settings", "List runtime settings (+ /{category})", false},
	{"/admin/settings/effective", []string{"get"}, "settings", "List effective settings with source layers", false},
	{"/admin/settings/by-key/{key}", []string{"put", "delete"}, "settings", "Set / revert a runtime setting", false},
	{"/admin/settings/validate", []string{"post"}, "settings", "Validate a setting value", false},
	{"/admin/settings/history", []string{"get"}, "settings", "Setting change history", false},
	{"/admin/settings/rollback", []string{"post"}, "settings", "Roll back a setting", false},
	{"/admin/settings/bulk", []string{"put"}, "settings", "Apply multiple settings atomically", false},
	{"/admin/settings/export", []string{"get"}, "settings", "Export non-secret setting overrides", false},
	{"/admin/settings/import", []string{"post"}, "settings", "Import settings (rejects secret keys)", false},
	{"/admin/settings/test/clickhouse", []string{"post"}, "settings", "Test ClickHouse connectivity", false},
	{"/admin/settings/test/text2sql-exec", []string{"post"}, "settings", "Test Text2SQL execute DB", false},
	{"/admin/settings/test/text2sql-twin", []string{"post"}, "settings", "Test Text2SQL twin DB", false},

	// ---- admin: pricing / cost ----
	{"/admin/pricing", []string{"get", "post"}, "cost", "Effective pricing + version history / add version", false},
	{"/admin/pricing/seed", []string{"post"}, "cost", "Seed the built-in pricing catalog", false},
	{"/admin/cost", []string{"get"}, "cost", "Cost guard overview", false},
	{"/admin/cost/predict", []string{"get", "post"}, "cost", "Predict request cost", false},
	{"/admin/cost/allocation", []string{"get"}, "cost", "Cost allocation by dimension", false},
	{"/admin/cost/chargeback-pack", []string{"get"}, "cost", "Monthly multi-dimension chargeback pack (?month=&dimensions=&format=csv)", false},
	{"/admin/cost/anomalies", []string{"get"}, "cost", "Cost anomaly detection", false},
	{"/admin/budgets", []string{"get", "post"}, "cost", "List / create budgets", false},
	{"/admin/budgets/{id}", []string{"put", "delete"}, "cost", "Update / delete a budget", false},
	{"/admin/budgets/alerts", []string{"get"}, "cost", "Budgets at warn/critical burn (optional Mattermost notify)", false},
	{"/admin/model-deprecations", []string{"get", "post"}, "routing", "List / upsert model deprecations (sunset policy)", false},
	{"/admin/model-deprecations/{id}", []string{"delete"}, "routing", "Delete a model deprecation", false},
	{"/admin/savings", []string{"get"}, "cost", "Savings report", false},
	{"/admin/invoices", []string{"get"}, "cost", "Cost-center invoices", false},
	{"/admin/carbon-score", []string{"get"}, "cost", "Prompt carbon score", false},
	{"/admin/ai-credit-score", []string{"get"}, "cost", "Internal AI credit score", false},
	{"/admin/work-map", []string{"get"}, "cost", "AI work map", false},
	{"/admin/model-migration", []string{"get"}, "cost", "Model migration advisor", false},
	{"/admin/insurance/claims", []string{"get"}, "cost", "AI request insurance — SLA claims", false},
	{"/admin/insurance/burn-rate", []string{"get"}, "cost", "Error-budget burn rate", false},

	// ---- admin: routing ----
	{"/admin/routing-rules", []string{"get", "post"}, "routing", "List / create routing rules", false},
	{"/admin/routing-rules/{id}", []string{"put", "delete"}, "routing", "Update / delete a routing rule", false},
	{"/admin/routing/preview", []string{"get", "post"}, "routing", "Preview routing decision", false},
	{"/admin/routing/decisions", []string{"get"}, "routing", "Routing decisions", false},
	{"/admin/routing/decisions/{id}", []string{"get"}, "routing", "Routing decision detail", false},
	{"/admin/routing/health", []string{"get"}, "routing", "Provider routing health", false},
	{"/admin/routing/learning", []string{"get"}, "routing", "Routing learning suggestions", false},
	{"/admin/routing/learning/auto", []string{"post"}, "routing", "Apply auto routing learning", false},
	{"/admin/routing/domain-decisions", []string{"get"}, "routing", "Domain routing decisions and signals", false},
	{"/admin/routing/domain-examples", []string{"get"}, "routing", "Auto-promoted domain routing examples", false},
	{"/admin/routing/domain-review", []string{"get"}, "routing", "Domain routing review queue", false},
	{"/admin/routing/domain-review/{id}", []string{"post"}, "routing", "Approve/reject domain routing review item", false},
	{"/admin/models/quality", []string{"get"}, "routing", "Per-model coding quality", false},
	{"/admin/models/contracts", []string{"get", "post", "delete"}, "routing", "Per-task-type model quality contracts", false},
	{"/admin/models/contracts/run", []string{"post"}, "routing", "Run a model against its quality contract(s)", false},

	// ---- admin: governance ----
	{"/admin/policies", []string{"get", "post"}, "governance", "List / create governance policies", false},
	{"/admin/policies/decisions", []string{"get"}, "governance", "Policy decisions", false},
	{"/admin/policies/simulate", []string{"post"}, "governance", "Simulate policy outcome", false},
	{"/admin/policies/canary-status", []string{"get"}, "governance", "Canary policies: enforced vs shadow activity + suggested rollout", false},
	{"/admin/policy-advisor/suggestions", []string{"get"}, "governance", "Recommended governance rules from observed signals", false},
	{"/admin/policy-advisor/apply", []string{"post"}, "governance", "Create a disabled draft policy from a suggestion", false},
	{"/admin/policies/regression/cases", []string{"get", "post", "delete"}, "governance", "Policy regression test cases", false},
	{"/admin/policies/regression/run", []string{"post"}, "governance", "Run policy regression suite", false},
	{"/admin/policies/export", []string{"get"}, "governance", "Export policies (GitOps)", false},
	{"/admin/policies/import", []string{"post"}, "governance", "Import policies (dry-run supported)", false},
	{"/admin/approvals", []string{"get"}, "governance", "Approval queue", false},
	{"/admin/approvals/{id}", []string{"post"}, "governance", "Approve/reject ({id}/approve|/reject)", false},
	{"/admin/security/secrets", []string{"get"}, "governance", "Secret-leak events", false},
	{"/admin/replay", []string{"get"}, "governance", "Request replay", false},
	{"/admin/golden-prompts", []string{"get", "post"}, "governance", "List / create golden prompts", false},
	{"/admin/golden-prompts/run", []string{"post"}, "governance", "Run golden prompt regression", false},
	{"/admin/golden-workflows", []string{"get", "post"}, "governance", "List / create golden workflows", false},
	{"/admin/golden-workflows/run", []string{"post"}, "governance", "Run a golden workflow", false},
	{"/admin/prompt-products", []string{"get", "post", "delete"}, "governance", "Prompt products (promote/list/delete)", false},
	{"/admin/prompt-products/candidates", []string{"get"}, "governance", "Prompt product candidates", false},
	{"/admin/prompts/fingerprints", []string{"get"}, "governance", "Prompt fingerprints", false},
	{"/admin/prompts/debt", []string{"get"}, "governance", "Prompt debt ranking (failing/expensive/model-waste/high-volume)", false},
	{"/admin/prompts/promotions", []string{"get", "post"}, "governance", "Prompt version promotions", false},

	// ---- admin: Text2SQL ----
	{"/admin/text2sql", []string{"get"}, "text2sql", "Text2SQL query logs / admin overview", false},
	{"/admin/text2sql/spans", []string{"get"}, "text2sql", "Text2SQL per-request pipeline spans", false},
	{"/admin/text2sql/schemas", []string{"get", "post", "delete"}, "text2sql", "Schema registry", false},
	{"/admin/text2sql/profiles", []string{"get", "post", "delete"}, "text2sql", "Virtual-model profiles", false},
	{"/admin/text2sql/tables", []string{"get", "post", "delete"}, "text2sql", "Registry tables", false},
	{"/admin/text2sql/columns", []string{"get", "post", "delete"}, "text2sql", "Registry columns + sensitivity", false},
	{"/admin/text2sql/collect", []string{"post"}, "text2sql", "Collect information_schema", false},
	{"/admin/text2sql/permissions", []string{"get", "post", "delete"}, "text2sql", "Permission matrix", false},
	{"/admin/text2sql/glossary", []string{"get", "post", "delete"}, "text2sql", "Business glossary", false},
	{"/admin/text2sql/risk-queue", []string{"get"}, "text2sql", "Risky request queue", false},
	{"/admin/text2sql/healthcheck", []string{"get"}, "text2sql", "Execute DB read-only healthcheck", false},
	{"/admin/text2sql/schema-impact", []string{"get"}, "text2sql", "Schema-change impact report", false},
	{"/admin/text2sql/replay", []string{"get"}, "text2sql", "Replay bundles", false},
	{"/admin/text2sql/kill-switch", []string{"get", "post"}, "text2sql", "Text2SQL kill switch", false},
	{"/admin/text2sql/miners", []string{"get"}, "text2sql", "Insight miners (report/glossary candidates)", false},
	{"/admin/text2sql/anomalies", []string{"get"}, "text2sql", "Behavioral anomaly detection", false},
	{"/admin/text2sql/prompt-dna", []string{"get"}, "text2sql", "Prompt DNA analysis", false},
	{"/admin/text2sql/promote", []string{"post"}, "text2sql", "Promote question → report/golden/glossary", false},
	{"/admin/text2sql/reports", []string{"get", "post", "delete"}, "text2sql", "Saved reports (schedule/MM delivery)", false},
	{"/admin/text2sql/features", []string{"get", "post"}, "text2sql", "Feature toggles", false},
	{"/admin/text2sql/golden", []string{"get", "post", "delete"}, "text2sql", "Golden queries (+ /run, /{id})", false},

	// ---- admin: OKF ----
	{"/admin/okf/documents", []string{"get", "post"}, "okf", "List / upsert OKF documents", false},
	{"/admin/okf/documents/by-id/{id}", []string{"get", "delete"}, "okf", "Get / delete an OKF document", false},
	{"/admin/okf/links", []string{"get", "post"}, "okf", "List / upsert knowledge-graph links", false},
	{"/admin/okf/export", []string{"get"}, "okf", "Export an OKF bundle", false},
	{"/admin/okf/import", []string{"post"}, "okf", "Import an OKF bundle", false},
	{"/admin/okf/text2sql/sync", []string{"post"}, "okf", "Seed OKF docs from the schema registry", false},
	{"/admin/okf/graph/sync", []string{"post"}, "okf", "Build the gateway knowledge graph", false},
	{"/admin/okf/propose", []string{"post"}, "okf", "Propose OKF docs from recurring questions", false},
	{"/v1/skills", []string{"get"}, "skills", "List production skills (caller-facing)", true},
	{"/v1/skills/{name}", []string{"get"}, "skills", "Get one production skill with instructions", true},
	{"/admin/skills", []string{"get", "post"}, "skills", "List (all statuses) / create-upsert a skill", false},
	{"/admin/skills/by-name/{name}", []string{"get", "delete"}, "skills", "Get / delete one skill", false},
	{"/admin/skills/runs", []string{"get"}, "skills", "Skill execution log", false},
	{"/admin/skills/stats", []string{"get"}, "skills", "Per-skill execution/cost aggregates", false},
	{"/admin/skills/promote", []string{"post"}, "skills", "Promote a skill through its lifecycle (gated)", false},
	{"/admin/skills/promotions", []string{"get"}, "skills", "Skill promotion history", false},
	{"/admin/skills/scan", []string{"get"}, "skills", "Security-scan one or all skills", false},
	{"/admin/skills/recommend", []string{"post"}, "skills", "Recommend draft skills from recurring usage", false},
	{"/admin/skills/export", []string{"get"}, "skills", "Export a portable skill bundle", false},
	{"/admin/skills/import", []string{"post"}, "skills", "Import a skill bundle (security-gated)", false},
	{"/admin/skills/evaluate", []string{"post"}, "skills", "Dry-run a skill's policy against a model/tools", false},
	{"/admin/skills/seed-recommended", []string{"post"}, "skills", "Seed the recommended starter skills", false},
	{"/admin/skills/dependency-graph", []string{"get"}, "skills", "Skill→model/tool/team/policy dependency graph (?skill=)", false},

	// ---- admin: data products ----
	{"/admin/workflows", []string{"get", "post", "delete"}, "data-products", "Workflow chain definitions", false},
	{"/admin/workflows/{id}/dry-run", []string{"post"}, "data-products", "Validate a workflow's steps (no execution)", false},
	{"/admin/workflows/{id}/publish", []string{"post"}, "data-products", "Publish a workflow: snapshot a version and enable it", false},
	{"/admin/workflows/{id}/versions", []string{"get"}, "data-products", "List a workflow's published version history", false},
	{"/v1/workflows/{id}/run", []string{"post"}, "self-service", "Run a workflow chain (records run, returns plan)", false},
	{"/me/workflow-runs", []string{"get"}, "self-service", "Caller's workflow run history", false},
	{"/admin/app-templates", []string{"get"}, "data-products", "Built-in AI work-app starter templates", false},
	{"/admin/app-templates/instantiate", []string{"post"}, "data-products", "Create a work app from a template", false},
	// ---- AI work apps (catalog) ----
	{"/v1/apps", []string{"get"}, "apps", "List AI work apps visible to the caller", false},
	{"/v1/apps/{id}", []string{"get"}, "apps", "Get one AI work app the caller may see", false},
	{"/v1/apps/{id}/run", []string{"post"}, "apps", "Run an AI work app (records a run; returns plan + run id)", false},
	{"/admin/apps", []string{"get", "post"}, "apps", "List/create AI work apps", false},
	{"/admin/apps/{id}", []string{"get", "put", "patch", "delete"}, "apps", "Get/update/delete a work app", false},
	{"/admin/apps/{id}/validate", []string{"post"}, "apps", "Validate a work app's components and permissions", false},
	{"/admin/apps/{id}/publish", []string{"post"}, "apps", "Publish a work app: snapshot a version and make it active", false},
	{"/admin/apps/{id}/deprecate", []string{"post"}, "apps", "Deprecate (hide) a work app", false},
	{"/admin/apps/{id}/versions", []string{"get"}, "apps", "List a work app's published version history", false},
	{"/admin/apps/{id}/permissions", []string{"get", "post", "delete"}, "apps", "List/grant/revoke explicit per-app access (user|team)", false},
	// ---- self-service (/me) personal surfaces ----
	{"/me/actions", []string{"get"}, "self-service", "Personal action queue (things to act on now)", false},
	{"/me/actions/snooze", []string{"post"}, "self-service", "Snooze an action-queue item", false},
	{"/me/navigation", []string{"get"}, "self-service", "Personalized navigation menu for the caller", false},
	{"/me/notifications", []string{"get"}, "self-service", "Unified personal notification feed", false},
	{"/me/recommended-models", []string{"get"}, "self-service", "Recommended models for the caller's work", false},
	{"/me/overlay", []string{"get"}, "self-service", "Compact status snapshot (model/budget/action items) for an IDE overlay", false},
	{"/me/report", []string{"get"}, "self-service", "Personal weekly/monthly usage report (?window=)", false},
	{"/me/reports/submit-to-team", []string{"post"}, "self-service", "Submit a saved report for team publication", false},
	{"/me/sessions", []string{"get"}, "self-service", "List the caller's active login sessions", false},
	{"/me/sessions/{id}", []string{"delete"}, "self-service", "Revoke one of the caller's sessions", false},
	{"/me/sessions/revoke-others", []string{"post"}, "self-service", "Revoke all of the caller's sessions except the current one", false},
	{"/me/skills", []string{"get"}, "self-service", "Skills available/requestable by the caller", false},
	{"/me/skills/{name}/request", []string{"post"}, "self-service", "Request access to a skill", false},
	{"/me/access-denied", []string{"get"}, "self-service", "Explain why the caller was denied access (self-diagnostic)", false},
	{"/v1/model-tags", []string{"get"}, "models", "Model usage tags (purpose labels) for the caller", false},
	{"/v1", []string{"get", "post"}, "openai", "OpenAI-compatible passthrough root (proxies other /v1/* paths upstream)", false},
	// ---- Keycloak SSO / auth ----
	{"/auth/sso/status", []string{"get"}, "auth", "Whether SSO is enabled + the login URL", true},
	{"/auth/keycloak/login", []string{"get"}, "auth", "Start the Keycloak Authorization Code + PKCE login", true},
	{"/auth/keycloak/callback", []string{"get"}, "auth", "Keycloak login callback (code exchange)", true},
	{"/auth/keycloak/logout", []string{"post"}, "auth", "Log out and return the Keycloak end-session URL", false},
	{"/auth/keycloak/backchannel-logout", []string{"post"}, "auth", "OIDC back-channel logout (logout_token)", true},
	{"/auth/keycloak/frontchannel-logout", []string{"get"}, "auth", "OIDC front-channel logout (iframe)", true},
	// ---- team / personal dashboards ----
	{"/team/dashboard", []string{"get"}, "self-service", "Team self-service dashboard", false},
	{"/team/onboarding", []string{"get"}, "self-service", "Team onboarding pack", false},
	{"/team/reports", []string{"get"}, "self-service", "Team's saved reports", false},
	{"/team/risk", []string{"get"}, "self-service", "Team risk summary", false},
	{"/team/savings-challenge", []string{"get"}, "self-service", "Team savings challenge leaderboard", false},
	{"/team/skills/popular", []string{"get"}, "self-service", "Most-used skills in the team", false},
	{"/team/templates/candidates", []string{"get"}, "self-service", "Suggested app/report templates for the team", false},
	{"/permissions/effective", []string{"get"}, "self-service", "The caller's effective scopes/permissions", false},
	{"/billing/dashboard", []string{"get"}, "billing", "Caller-visible billing dashboard", false},
	{"/security/dashboard", []string{"get"}, "security", "Caller-visible security dashboard", false},
	// ---- admin: ops / capabilities ----
	{"/admin/capabilities", []string{"get"}, "ops", "Capability catalog (features + their APIs/tables)", false},
	{"/admin/capabilities/{key}", []string{"get"}, "ops", "One capability's detail", false},
	{"/admin/ops/home", []string{"get"}, "ops", "Operations home overview", false},
	{"/admin/ops/workers", []string{"get"}, "ops", "Background worker status board", false},
	{"/admin/ops/preflight", []string{"get"}, "ops", "Pre-deploy readiness checks", false},
	{"/admin/flow-map", []string{"get"}, "ops", "Request flow map", false},
	{"/admin/system-errors", []string{"get"}, "ops", "Recent system errors", false},
	{"/admin/system-errors/clear", []string{"post"}, "ops", "Clear the system error log", false},
	{"/admin/change-sets", []string{"get", "post"}, "ops", "List/create config change sets", false},
	{"/admin/change-sets/{id}", []string{"get", "post"}, "ops", "Get/apply a change set", false},
	{"/admin/change-impact/simulate", []string{"post"}, "ops", "Simulate the impact of a config change", false},
	// ---- admin: chat test (multi-model) ----
	{"/admin/chat-test/stream", []string{"post"}, "chat-test", "Streaming chat test", false},
	{"/admin/chat-test/multi-run", []string{"post"}, "chat-test", "Run a prompt across multiple models", false},
	{"/admin/chat-test/multi-run/judge", []string{"post"}, "chat-test", "LLM-judge a multi-model run", false},
	{"/admin/chat-test/multi-run/predict", []string{"post"}, "chat-test", "Predict cost/latency of a multi-model run", false},
	{"/admin/chat-test/multi-run/leaderboard", []string{"get"}, "chat-test", "Multi-model leaderboard", false},
	{"/admin/chat-test/multi-run/runs", []string{"get"}, "chat-test", "List multi-model test runs", false},
	{"/admin/chat-test/multi-run/runs/{id}", []string{"get", "post"}, "chat-test", "Get a run / submit feedback", false},
	{"/admin/chat-test/multi-run/runs/{id}/code-verify", []string{"get"}, "chat-test", "Code verification leaderboard across a run's models", false},
	// ---- admin: DW / ClickHouse ----
	{"/admin/dw/metrics", []string{"get", "post"}, "clickhouse", "Metric catalog: list/upsert", false},
	{"/admin/dw/metrics/{key}", []string{"post"}, "clickhouse", "Update one metric definition", false},
	{"/admin/dw/clickhouse/events", []string{"get"}, "clickhouse", "Recent ClickHouse sink events", false},
	{"/admin/dw/clickhouse/fact-retry", []string{"post"}, "clickhouse", "Retry failed fact inserts", false},
	{"/admin/dw/clickhouse/lag", []string{"get"}, "clickhouse", "ClickHouse sink lag", false},
	// ---- admin: MCP observability ----
	{"/admin/mcp/agentic-runs", []string{"get"}, "mcp", "MCP agentic discovery run history", false},
	{"/admin/mcp/trust-scores", []string{"get"}, "mcp", "MCP server trust scores", false},
	// ---- admin: model tags ----
	{"/admin/model-tags", []string{"get", "post"}, "models", "List/create model usage tags", false},
	{"/admin/model-tags/{id}", []string{"delete"}, "models", "Delete a model usage tag", false},
	// ---- admin: prompt assets / lab ----
	{"/admin/prompt-assets", []string{"get"}, "prompt-lab", "Reusable prompt assets", false},
	{"/admin/prompt-lab/experiments", []string{"get", "post"}, "prompt-lab", "List/create prompt experiments", false},
	{"/admin/prompt-lab/experiments/{id}", []string{"get"}, "prompt-lab", "Experiment detail (+ runs)", false},
	{"/admin/prompt-lab/rubrics", []string{"get", "post"}, "prompt-lab", "Evaluation rubrics", false},
	{"/admin/prompt-lab/contracts", []string{"get", "post"}, "prompt-lab", "Output contracts", false},
	{"/admin/prompt-lab/test-cases", []string{"post"}, "prompt-lab", "Create a test case", false},
	{"/admin/prompt-lab/test-cases/{id}", []string{"get", "delete"}, "prompt-lab", "Get/delete a test case", false},
	// ---- admin: skills ----
	{"/admin/skills/fitness", []string{"get"}, "skills", "Skill fitness scores", false},
	{"/admin/skills/adoption", []string{"get"}, "skills", "Skill adoption metrics", false},
	{"/admin/skill-studio/candidates", []string{"get"}, "skills", "Skill candidates mined from usage", false},
	{"/admin/skill-studio/adopt", []string{"post"}, "skills", "Adopt a skill candidate", false},
	{"/admin/skill-studio/readiness", []string{"get"}, "skills", "Skill-studio readiness checks", false},
	// ---- admin: RBAC / secrets / SSO ----
	{"/admin/roles", []string{"get", "post"}, "rbac", "List/create custom roles", false},
	{"/admin/secrets/rotate", []string{"post"}, "security", "Rotate the gateway secret", false},
	{"/admin/sso/keycloak/config", []string{"get", "put"}, "auth", "Get/save the DB-backed Keycloak provider config", false},
	{"/admin/sso/keycloak/test", []string{"post"}, "auth", "Diagnose the Keycloak connection", false},
	// ---- admin: Text2SQL registry ----
	{"/admin/text2sql/connections", []string{"get", "post"}, "text2sql", "Manage Text2SQL DB connections", false},
	{"/admin/text2sql/registry/export", []string{"get"}, "text2sql", "Export the Text2SQL schema registry", false},
	{"/admin/text2sql/registry/import", []string{"post"}, "text2sql", "Import a Text2SQL schema registry", false},
	// ---- admin: XView model analytics ----
	{"/admin/xview/models", []string{"get"}, "observability", "Model comparison (XView)", false},
	{"/admin/xview/model-series", []string{"get"}, "observability", "Model time series (XView)", false},
	{"/admin/xview/model-outliers", []string{"get"}, "observability", "Model outliers (XView)", false},
	{"/admin/data-products", []string{"get", "post", "delete"}, "data-products", "Curate/publish the data product catalog", false},
	{"/admin/data-products/candidates", []string{"get"}, "data-products", "Suggest products from recurring Text2SQL questions (no raw SQL)", false},
	{"/admin/data-products/requests", []string{"get", "post"}, "data-products", "List / decide data product access requests", false},

	// ---- admin: data warehouse (ClickHouse) ----
	{"/admin/dw/rollups", []string{"get", "post"}, "dw", "Daily rollups / backfill", false},
	{"/admin/dw/clickhouse", []string{"post"}, "dw", "Ship rollups to ClickHouse", false},
	{"/admin/dw/clickhouse/bootstrap", []string{"post"}, "dw", "Create ClickHouse tables (IF NOT EXISTS)", false},
	{"/admin/dw/clickhouse/overview", []string{"get"}, "dw", "ClickHouse DW health overview", false},
	{"/admin/dw/dashboard/overview", []string{"get"}, "dw", "DW dashboard KPI cards (rollup)", false},
	{"/admin/dw/dashboard/timeseries", []string{"get"}, "dw", "DW dashboard daily time series", false},
	{"/admin/dw/dashboard/dimensions", []string{"get"}, "dw", "DW dashboard Top-N by dimension", false},
	{"/admin/dw/dashboard/text2sql", []string{"get"}, "dw", "DW dashboard Text2SQL analytics", false},
	{"/admin/dw/dashboard/routing", []string{"get"}, "dw", "DW dashboard routing-decision analytics", false},
	{"/admin/dw/dashboard/latency", []string{"get"}, "dw", "DW dashboard latency/performance analytics", false},
	{"/admin/dw/dashboard/quality", []string{"get"}, "dw", "DW dashboard quality analytics (eval + feedback)", false},
	{"/admin/dw/dashboard/refresh", []string{"post"}, "dw", "Clear the DW dashboard query cache", false},
	{"/admin/dw/dashboard/export.csv", []string{"get"}, "dw", "DW dashboard CSV export (current filter)", false},
	{"/admin/dw/consistency", []string{"get"}, "dw", "Local vs ClickHouse consistency", false},
	{"/admin/dw/sink-status", []string{"get"}, "dw", "Sink watermarks + retry queue", false},
	{"/admin/dw/sink-retry", []string{"post"}, "dw", "Reprocess sink retry queue", false},
	{"/admin/dw/table-info", []string{"get"}, "dw", "Inspect target table engine/sort key", false},
	{"/admin/dw/text2sql-fact", []string{"post"}, "dw", "Ship Text2SQL facts", false},

	// ---- admin: LLM observability ----
	{"/admin/llm/traces", []string{"get"}, "llm", "LLM traces", false},
	{"/admin/llm/traces/{id}", []string{"get"}, "llm", "LLM trace detail", false},
	{"/admin/llm/sessions", []string{"get"}, "llm", "LLM sessions", false},
	{"/admin/llm/session", []string{"get"}, "llm", "Session timeline", false},
	{"/admin/llm/prompts", []string{"get"}, "llm", "Prompt tracking", false},
	{"/admin/llm/prompts/compare", []string{"get"}, "llm", "Compare prompts", false},
	{"/admin/llm/patterns", []string{"get"}, "llm", "Conversation patterns", false},
	{"/admin/llm/insights", []string{"get"}, "llm", "LLM insights", false},
	{"/admin/llm/timeseries", []string{"get"}, "llm", "LLM timeseries", false},
	{"/admin/llm/feedback", []string{"get", "post"}, "llm", "LLM feedback", false},
	{"/admin/llm/evaluations", []string{"get"}, "llm", "LLM evaluations", false},

	// ---- admin: MCP governance ----
	{"/admin/mcp/tools", []string{"get"}, "mcp", "MCP tool risk grades", false},
	{"/admin/mcp/servers", []string{"get"}, "mcp", "MCP servers", false},
	{"/admin/mcp/overview", []string{"get"}, "mcp", "MCP operations overview", false},
	{"/admin/mcp/routes", []string{"get"}, "mcp", "MCP namespaced route map", false},
	{"/admin/mcp/route/explain", []string{"post"}, "mcp", "Explain MCP route and policy decision", false},
	{"/admin/mcp/test", []string{"post"}, "mcp", "Run an MCP upstream test call", false},
	{"/admin/mcp/effective-policy", []string{"get"}, "mcp", "Effective MCP server/tool policy", false},
	{"/admin/mcp/topology", []string{"get"}, "mcp", "MCP topology graph data", false},
	{"/admin/mcp/requests", []string{"get"}, "mcp", "MCP request log", false},
	{"/admin/mcp/requests/{id}/waterfall", []string{"get"}, "mcp", "MCP request routing waterfall", false},
	{"/admin/mcp/policies", []string{"get", "post"}, "mcp", "MCP policies", false},
	{"/admin/mcp/policies/{server}", []string{"get", "put", "delete"}, "mcp", "MCP policy by server", false},
	{"/admin/mcp/loops", []string{"get"}, "mcp", "MCP tool-call loops", false},
	{"/admin/mcp/catalog", []string{"get"}, "mcp", "MCP catalog", false},
	{"/admin/mcp/upstreams", []string{"get", "post"}, "mcp", "MCP upstreams", false},
	{"/admin/mcp/upstreams/{id}", []string{"get", "put", "delete"}, "mcp", "MCP upstream by id", false},
	{"/admin/mcp/upstreams/{id}/flow", []string{"get"}, "mcp", "MCP upstream operational flow", false},

	// ---- admin: personalization / knowledge / templates / notifications ----
	{"/admin/personalization/coaching", []string{"get"}, "admin", "Personalized coaching candidates", false},
	{"/admin/personalization/model-affinity", []string{"get"}, "admin", "Per-user model affinity", false},
	{"/admin/personalization/mcp-affinity", []string{"get"}, "admin", "Per-user MCP tool affinity", false},
	{"/admin/personalization/text2sql-hints", []string{"get"}, "admin", "Per-user Text2SQL report hints", false},
	{"/admin/personalization/profiles", []string{"get"}, "admin", "Personal AI profiles", false},
	{"/admin/personalization/profiles/{user_id}", []string{"get", "post"}, "admin", "Profile detail / snapshot / drift", false},
	{"/admin/recommendations/adoption", []string{"get"}, "admin", "Recommendation adoption rates", false},
	{"/admin/knowledge", []string{"get", "post"}, "admin", "Knowledge base entries", false},
	{"/admin/knowledge/{id}", []string{"get", "put", "delete"}, "admin", "Knowledge entry by id", false},
	{"/admin/templates", []string{"get", "post"}, "admin", "Work templates", false},
	{"/admin/templates/{id}", []string{"get", "put", "delete"}, "admin", "Template by id", false},
	{"/admin/agents", []string{"get"}, "admin", "Agents", false},
	{"/admin/vcs/events", []string{"get"}, "admin", "VCS events", false},
	{"/admin/benchmark/teams", []string{"get"}, "admin", "Team benchmark", false},
	{"/admin/benchmark/users", []string{"get"}, "admin", "User productivity", false},
	{"/admin/ops/status", []string{"get"}, "admin", "Ops health status", false},
	{"/admin/ops/risk", []string{"get"}, "admin", "Operational risk score", false},
	{"/admin/alerts", []string{"get", "post"}, "admin", "Alert rules", false},
	{"/admin/alerts/{id}", []string{"put", "delete"}, "admin", "Alert rule by id", false},
	{"/admin/saved-filters", []string{"get", "post"}, "admin", "Saved filters", false},
	{"/admin/saved-filters/{id}", []string{"put", "delete"}, "admin", "Saved filter by id", false},
	{"/admin/notifications/mattermost", []string{"get", "post"}, "notifications", "Mattermost config", false},
	{"/admin/notifications/mattermost/test", []string{"post"}, "notifications", "Send a test Mattermost message", false},
}

// buildOpenAPISpec assembles the full OpenAPI 3.0 document from apiEndpoints.
func buildOpenAPISpec() map[string]any {
	paths := map[string]any{}
	tagSet := map[string]bool{}
	for _, e := range apiEndpoints {
		ops := map[string]any{}
		for _, m := range e.methods {
			op := map[string]any{
				"tags":      []string{e.tag},
				"summary":   e.summary,
				"responses": map[string]any{"200": map[string]any{"description": "OK"}},
			}
			if !e.public {
				op["security"] = []any{map[string]any{"bearerAuth": []any{}}}
			}
			ops[m] = op
		}
		// Path-level parameter for templated paths.
		if i := strings.IndexByte(e.path, '{'); i >= 0 {
			name := e.path[i+1 : strings.IndexByte(e.path, '}')]
			for _, m := range e.methods {
				op := ops[m].(map[string]any)
				op["parameters"] = []any{map[string]any{
					"name": name, "in": "path", "required": true, "schema": map[string]any{"type": "string"},
				}}
			}
		}
		paths[e.path] = ops
		tagSet[e.tag] = true
	}
	tags := []any{}
	for _, t := range []string{"ops", "inference", "auth", "self-service", "admin", "settings", "cost", "routing", "governance", "text2sql", "okf", "skills", "dw", "llm", "mcp", "vcs", "notifications"} {
		if tagSet[t] {
			tags = append(tags, map[string]any{"name": t})
		}
	}
	return map[string]any{
		"openapi": "3.0.3",
		"info": map[string]any{
			"title":       "AI Proxy Gateway API",
			"version":     AppVersion,
			"description": "OpenAI-compatible AI control-plane gateway. This document covers the full HTTP surface; request/response bodies are summarized — see the admin UI for live examples.",
		},
		"servers": []any{map[string]any{"url": "/", "description": "this gateway"}},
		"tags":    tags,
		"paths":   paths,
		"components": map[string]any{
			"securitySchemes": map[string]any{
				"bearerAuth": map[string]any{"type": "http", "scheme": "bearer", "bearerFormat": "JWT or API key"},
			},
		},
	}
}

// handleOpenAPISpec serves the generated OpenAPI 3.0 document. Public (no auth) so the docs
// are reachable; it describes the surface, not secrets.
// GET /openapi.json
func (s *Server) handleOpenAPISpec(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(buildOpenAPISpec())
}

// handleSwaggerUI serves a Swagger UI page pointing at /openapi.json. Swagger UI assets are
// loaded from a CDN; in an air-gapped network the page won't render, but /openapi.json is
// always downloadable directly.
// GET /swagger
func (s *Server) handleSwaggerUI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Air-gapped networks can't reach the Swagger CDN; ?offline=1 serves a fully self-contained
	// explorer (no external CSS/JS) that renders /openapi.json inline.
	if r.URL.Query().Get("offline") != "" {
		_, _ = w.Write([]byte(swaggerOfflineHTML))
		return
	}
	_, _ = w.Write([]byte(swaggerUIHTML))
}

const swaggerUIHTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Gateway API — Swagger</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>body{margin:0}#hint{font:13px system-ui;padding:8px 14px;background:#fff3cd;color:#664d03;border-bottom:1px solid #ffe69c}</style>
</head>
<body>
  <div id="hint">오프라인(폐쇄망)에서는 Swagger UI 자산 로드가 실패할 수 있습니다. 그 경우 <a href="/swagger?offline=1">오프라인 API 탐색기</a> 또는 <a href="/openapi.json">/openapi.json</a>을 사용하세요.</div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.addEventListener('load', function () {
      if (!window.SwaggerUIBundle) return;
      window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui', deepLinking: true });
    });
  </script>
</body>
</html>`

// swaggerOfflineHTML is a fully self-contained API explorer (no external CSS/JS/fonts) that
// fetches /openapi.json and renders operations grouped by tag — for air-gapped networks.
const swaggerOfflineHTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Gateway API — 오프라인 탐색기</title>
  <style>
    :root{--bg:#0f1115;--card:#171a21;--line:#262b36;--muted:#8b94a7;--fg:#e6e9ef;--accent:#6ea8fe}
    body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    header{padding:14px 20px;border-bottom:1px solid var(--line)}
    header h1{font-size:17px;margin:0}
    header .sub{color:var(--muted);font-size:12px;margin-top:4px}
    #q{width:100%;max-width:480px;margin-top:8px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
    main{padding:16px 20px;max-width:1000px}
    .tag{margin:18px 0 6px;font-size:13px;font-weight:800;color:var(--accent);text-transform:uppercase;letter-spacing:.04em}
    .op{border:1px solid var(--line);border-radius:8px;margin:6px 0;background:var(--card);overflow:hidden}
    .op>summary{cursor:pointer;padding:8px 12px;display:flex;gap:10px;align-items:center;list-style:none}
    .op>summary::-webkit-details-marker{display:none}
    .m{font-weight:800;font-size:11px;padding:2px 8px;border-radius:6px;min-width:48px;text-align:center}
    .m.get{background:#163d2b;color:#7ee2a8}.m.post{background:#15314f;color:#7fb8ff}.m.put{background:#4a3a14;color:#ffd27f}
    .m.delete{background:#4a1d1d;color:#ff9b9b}.m.patch{background:#3a2747;color:#d6a8ff}
    .path{font-family:ui-monospace,Consolas,monospace;font-size:13px}
    .sum{color:var(--muted);margin-left:auto;font-size:12px}
    .body{padding:6px 14px 12px;border-top:1px solid var(--line);font-size:13px}
    table{border-collapse:collapse;width:100%;margin-top:6px}
    th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);font-size:12px;vertical-align:top}
    th{color:var(--muted);font-weight:600}
    .req{color:#ff9b9b;font-size:10px}
    .err{color:#ff9b9b;padding:20px}
  </style>
</head>
<body>
  <header>
    <h1>AI Gateway API — 오프라인 탐색기</h1>
    <div class="sub">외부 자산 없이 동작합니다. <a href="/openapi.json" style="color:var(--accent)">/openapi.json</a> 원본 · <a href="/swagger" style="color:var(--accent)">Swagger UI(온라인)</a></div>
    <input id="q" placeholder="경로/요약 필터…">
  </header>
  <main id="out"><div class="muted">불러오는 중…</div></main>
  <script>
    var METHODS = ['get','post','put','delete','patch','options','head'];
    function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
    function paramRows(params){
      if(!params||!params.length) return '';
      var rows = params.map(function(p){
        var t = (p.schema&&p.schema.type)||p.type||'';
        return '<tr><td>'+esc(p.name)+(p.required?' <span class="req">*</span>':'')+'</td><td>'+esc(p.in||'')+'</td><td>'+esc(t)+'</td><td>'+esc(p.description||'')+'</td></tr>';
      }).join('');
      return '<table><thead><tr><th>파라미터</th><th>위치</th><th>타입</th><th>설명</th></tr></thead><tbody>'+rows+'</tbody></table>';
    }
    function render(spec){
      var out = document.getElementById('out');
      var paths = spec.paths||{};
      var byTag = {};
      Object.keys(paths).sort().forEach(function(p){
        METHODS.forEach(function(m){
          var op = paths[p][m];
          if(!op) return;
          var tag = (op.tags&&op.tags[0])||'기타';
          (byTag[tag]=byTag[tag]||[]).push({path:p,method:m,op:op});
        });
      });
      var html = '';
      Object.keys(byTag).sort().forEach(function(tag){
        html += '<div class="tag">'+esc(tag)+' <span class="muted">('+byTag[tag].length+')</span></div>';
        byTag[tag].forEach(function(e){
          var resp = Object.keys(e.op.responses||{}).join(', ');
          html += '<details class="op" data-f="'+esc((e.path+' '+(e.op.summary||'')).toLowerCase())+'">'+
            '<summary><span class="m '+e.method+'">'+e.method.toUpperCase()+'</span>'+
            '<span class="path">'+esc(e.path)+'</span><span class="sum">'+esc(e.op.summary||'')+'</span></summary>'+
            '<div class="body">'+
              (e.op.description?'<div>'+esc(e.op.description)+'</div>':'')+
              paramRows(e.op.parameters)+
              (resp?'<div class="muted" style="margin-top:6px">응답: '+esc(resp)+'</div>':'')+
            '</div></details>';
        });
      });
      out.innerHTML = html || '<div class="muted">엔드포인트가 없습니다.</div>';
      document.getElementById('q').addEventListener('input', function(ev){
        var q = ev.target.value.toLowerCase();
        document.querySelectorAll('.op').forEach(function(el){ el.style.display = el.getAttribute('data-f').indexOf(q)>=0 ? '' : 'none'; });
      });
    }
    fetch('/openapi.json').then(function(r){return r.json();}).then(render).catch(function(e){
      document.getElementById('out').innerHTML = '<div class="err">스펙을 불러오지 못했습니다: '+esc(e.message)+'</div>';
    });
  </script>
</body>
</html>`
