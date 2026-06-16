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
	{"/me/recommendations/feedback", []string{"post"}, "self-service", "Record adopt/dismiss feedback on a recommendation", false},
	{"/me/keys", []string{"get", "post"}, "self-service", "List / issue the caller's own API keys", false},
	{"/me/keys/{id}", []string{"post", "delete"}, "self-service", "Rotate ({id}/rotate) or revoke the caller's key", false},

	// ---- admin UI ----
	{"/admin", []string{"get"}, "admin", "Admin dashboard (HTML)", false},

	// ---- admin: core analytics ----
	{"/admin/stats", []string{"get"}, "admin", "Summary stats", false},
	{"/admin/requests", []string{"get"}, "admin", "List recent requests", false},
	{"/admin/requests/{id}", []string{"get"}, "admin", "Request detail (prompts/response/spans/evaluations)", false},
	{"/admin/requests/diff", []string{"get"}, "admin", "Diff two requests", false},
	{"/admin/prompts", []string{"get"}, "admin", "Search prompts", false},
	{"/admin/timeseries", []string{"get"}, "admin", "Usage timeseries", false},
	{"/admin/heatmap", []string{"get"}, "admin", "Activity heatmap", false},
	{"/admin/scatter", []string{"get"}, "admin", "XView scatter data", false},
	{"/admin/waterfall", []string{"get"}, "admin", "Request waterfall", false},
	{"/admin/anomalies", []string{"get"}, "admin", "Request anomalies", false},
	{"/admin/incidents", []string{"get"}, "admin", "Incidents", false},
	{"/admin/suggest", []string{"get"}, "admin", "Autocomplete suggestions", false},
	{"/admin/export.csv", []string{"get"}, "admin", "Export request history (CSV)", false},
	{"/admin/contexts", []string{"get"}, "admin", "RAG/KB contexts", false},

	// ---- admin: identity ----
	{"/admin/users", []string{"get", "post"}, "admin", "List users / create auth user", false},
	{"/admin/users/{id}", []string{"get", "patch"}, "admin", "User detail / update; {id}/report for weekly report", false},
	{"/admin/teams", []string{"get", "post"}, "admin", "List / create teams", false},
	{"/admin/teams/{team}", []string{"get"}, "admin", "Team detail", false},
	{"/admin/ips", []string{"get"}, "admin", "List client IPs", false},
	{"/admin/ips/{ip}", []string{"get"}, "admin", "IP detail", false},
	{"/admin/api-keys", []string{"get", "post"}, "admin", "List / create API keys", false},
	{"/admin/api-keys/{id}", []string{"get", "patch", "delete"}, "admin", "API key detail / update / revoke ({id}/revoke)", false},
	{"/admin/keys/health", []string{"get"}, "admin", "API key hygiene alerts (expiring/idle)", false},
	{"/admin/providers", []string{"get", "post"}, "admin", "List / upsert providers", false},
	{"/admin/providers/{name}", []string{"get", "put", "delete"}, "admin", "Provider detail / update / delete", false},
	{"/admin/providers/slo", []string{"get"}, "admin", "Provider SLOs", false},

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
	{"/admin/cost/anomalies", []string{"get"}, "cost", "Cost anomaly detection", false},
	{"/admin/budgets", []string{"get", "post"}, "cost", "List / create budgets", false},
	{"/admin/budgets/{id}", []string{"put", "delete"}, "cost", "Update / delete a budget", false},
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
	{"/admin/models/quality", []string{"get"}, "routing", "Per-model coding quality", false},

	// ---- admin: governance ----
	{"/admin/policies", []string{"get", "post"}, "governance", "List / create governance policies", false},
	{"/admin/policies/decisions", []string{"get"}, "governance", "Policy decisions", false},
	{"/admin/policies/simulate", []string{"post"}, "governance", "Simulate policy outcome", false},
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
	{"/admin/prompts/promotions", []string{"get", "post"}, "governance", "Prompt version promotions", false},

	// ---- admin: Text2SQL ----
	{"/admin/text2sql", []string{"get"}, "text2sql", "Text2SQL query logs / admin overview", false},
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
	{"/admin/skills/evaluate", []string{"post"}, "skills", "Dry-run a skill's policy against a model/tools", false},
	{"/admin/skills/seed-recommended", []string{"post"}, "skills", "Seed the recommended starter skills", false},

	// ---- admin: data warehouse (ClickHouse) ----
	{"/admin/dw/rollups", []string{"get", "post"}, "dw", "Daily rollups / backfill", false},
	{"/admin/dw/clickhouse", []string{"post"}, "dw", "Ship rollups to ClickHouse", false},
	{"/admin/dw/clickhouse/bootstrap", []string{"post"}, "dw", "Create ClickHouse tables (IF NOT EXISTS)", false},
	{"/admin/dw/clickhouse/overview", []string{"get"}, "dw", "ClickHouse DW health overview", false},
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
	{"/admin/mcp/requests", []string{"get"}, "mcp", "MCP request log", false},
	{"/admin/mcp/policies", []string{"get", "post"}, "mcp", "MCP policies", false},
	{"/admin/mcp/policies/{server}", []string{"get", "put", "delete"}, "mcp", "MCP policy by server", false},
	{"/admin/mcp/loops", []string{"get"}, "mcp", "MCP tool-call loops", false},
	{"/admin/mcp/catalog", []string{"get"}, "mcp", "MCP catalog", false},
	{"/admin/mcp/upstreams", []string{"get", "post"}, "mcp", "MCP upstreams", false},
	{"/admin/mcp/upstreams/{id}", []string{"get", "put", "delete"}, "mcp", "MCP upstream by id", false},

	// ---- admin: personalization / knowledge / templates / notifications ----
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
  <div id="hint">오프라인(폐쇄망)에서는 Swagger UI 자산 로드가 실패할 수 있습니다. 그 경우 <a href="/openapi.json">/openapi.json</a>을 직접 내려받아 사용하세요.</div>
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
