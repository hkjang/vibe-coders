import { z } from "zod";

import { looseList, looseObject, numberish, orDefault, unknownRecord } from "@/shared/api/loose";

// Response contracts for the legacy MCP, Gateway MCP and agent-registry admin APIs.
// Field names mirror the Go handlers (internal/proxy/admin_mcp*.go, admin_agent_routes.go);
// unlisted fields pass through so a server addition never breaks the screen.

const text = orDefault(z.string(), "");
const count = orDefault(numberish, 0);
const flag = orDefault(z.boolean(), false);
const textList = orDefault(z.array(z.string()), [] as string[]);
const errorMap = orDefault(z.record(z.string(), z.string()), {} as Record<string, string>);

const mcpFlowStepSchema = looseObject({ name: text, status: z.unknown(), detail: z.unknown() });
export type McpFlowStep = z.output<typeof mcpFlowStepSchema>;

const mcpDiscoveryRunSchema = looseObject({
  id: text,
  status: text,
  tool_count: count,
  prompt_count: count,
  resource_count: count,
  error: text,
  latency_ms: count,
  created_at: text,
});
export type McpDiscoveryRun = z.output<typeof mcpDiscoveryRunSchema>;

/* ---------------------------------------------------------------- upstreams */

export const mcpUpstreamMetadataSchema = looseObject({
  description: text,
  domains: textList,
  risk_level: text,
  allowed_models: textList,
  default_tool: text,
  timeout_ms: count,
  max_results: count,
  requires_approval: flag,
  fallback_allowed: flag,
});

export const mcpUpstreamSchema = looseObject({
  id: text,
  name: text,
  url: text,
  has_auth: flag,
  enabled: flag,
  created_at: text,
  metadata: mcpUpstreamMetadataSchema.optional(),
});
export type McpUpstream = z.output<typeof mcpUpstreamSchema>;

export const mcpUpstreamListSchema = looseObject({
  upstreams: orDefault(z.array(mcpUpstreamSchema), [] as McpUpstream[]),
  discovery_errors: errorMap,
});

export const mcpUpstreamWriteSchema = looseObject({ upstream: mcpUpstreamSchema.optional() });

export const mcpDeleteAcknowledgementSchema = looseObject({
  id: text,
  status: text,
});

/**
 * GET /admin/mcp/upstreams/{id}/probe — a fresh handshake against one upstream.
 * `ok` reflects tool discovery only; resources/prompts failures land in `errors`.
 */
export const mcpUpstreamProbeSchema = looseObject({
  id: text,
  name: text,
  url: text,
  ok: flag,
  tool_count: count,
  prompt_count: count,
  resource_count: count,
  tools: looseList({ name: text, namespaced: text, description: text }),
  prompts: looseList({ name: text, namespaced: text }),
  resources: looseList({ uri: text, name: text }),
  errors: errorMap,
});
export type McpUpstreamProbe = z.output<typeof mcpUpstreamProbeSchema>;

export const onboardingCheckSchema = looseObject({
  key: text,
  ok: flag,
  severity: text,
  detail: text,
});
export type OnboardingCheck = z.output<typeof onboardingCheckSchema>;

export const onboardingChecklistSchema = looseObject({
  ready: flag,
  missing: count,
  note: text,
  checks: orDefault(z.array(onboardingCheckSchema), [] as OnboardingCheck[]),
});

/** 422 body returned when an enabled upstream fails the onboarding gate. */
export const onboardingRejectionSchema = looseObject({
  error: looseObject({ message: text, code: text, type: text }).optional(),
  hint: text,
  failed: orDefault(z.array(onboardingCheckSchema), [] as OnboardingCheck[]),
  checks: orDefault(z.array(onboardingCheckSchema), [] as OnboardingCheck[]),
});

/* ----------------------------------------------------------------- overview */

export const mcpOverviewSchema = looseObject({
  upstream_count: count,
  enabled_upstream_count: count,
  healthy_upstream_count: count,
  total_tools: count,
  total_prompts: count,
  total_resources: count,
  discovery_error_count: count,
  blocked_count: count,
  recent_call_count: count,
  recent_error_rate: count,
  fetched_at: text,
  summary: looseObject({
    total_calls: count,
    total_errors: count,
    distinct_tools: count,
    mcp_servers: count,
  }).optional(),
});

export const mcpRouteSchema = looseObject({
  kind: text,
  exposed_name: text,
  uri: text,
  upstream_id: text,
  upstream_name: text,
  target_method: text,
  target_name: text,
  description: text,
  last_discovered_at: text,
  discovery_error: text,
});
export type McpRoute = z.output<typeof mcpRouteSchema>;

export const mcpRouteListSchema = looseObject({
  routes: orDefault(z.array(mcpRouteSchema), [] as McpRoute[]),
  fetched_at: text,
  errors: errorMap,
});

export const mcpTopologySchema = looseObject({
  nodes: looseList({ id: text, label: text, kind: text, status: text, decision: text }),
  edges: looseList({ from: text, to: text, label: text }),
});

/* -------------------------------------------------------------------- tools */

export const mcpToolStatSchema = looseObject({
  server_label: text,
  tool_name: text,
  is_mcp: flag,
  definitions: count,
  calls: count,
  results: count,
  errors: count,
  error_rate: count,
  distinct_keys: count,
  distinct_ips: count,
  last_seen: text,
});
export type McpToolStat = z.output<typeof mcpToolStatSchema>;

export const mcpToolRiskSchema = looseObject({
  server_label: text,
  tool_name: text,
  access_class: text,
  risk_level: text,
  action: text,
  recommended_action: text,
  configured: flag,
  note: text,
});
export type McpToolRisk = z.output<typeof mcpToolRiskSchema>;

export const mcpToolListSchema = looseObject({
  tools: orDefault(z.array(mcpToolStatSchema), [] as McpToolStat[]),
  tool_risk: orDefault(z.array(mcpToolRiskSchema), [] as McpToolRisk[]),
  risk_profiles: looseList({
    id: text,
    server_label: text,
    tool_name: text,
    risk_level: text,
    action: text,
    note: text,
    updated_at: text,
  }),
  count: count,
  filters: unknownRecord.optional(),
});

/** POST /admin/mcp/tools answers with the stored risk profile. */
export const mcpToolRiskWriteSchema = looseObject({
  profile: looseObject({
    id: text,
    server_label: text,
    tool_name: text,
    risk_level: text,
    action: text,
    note: text,
    updated_at: text,
  }).optional(),
});

export const mcpServerListSchema = looseObject({
  servers: looseList({
    server_label: text,
    is_mcp: flag,
    tools: count,
    calls: count,
    errors: count,
    error_rate: count,
    distinct_keys: count,
    distinct_ips: count,
    last_seen: text,
  }),
  summary: looseObject({
    total_calls: count,
    total_errors: count,
    distinct_tools: count,
    mcp_servers: count,
  }).optional(),
});

export const mcpCatalogSchema = looseObject({
  catalog: looseList({
    server_label: text,
    tool_name: text,
    is_mcp: flag,
    first_seen: text,
    last_seen: text,
    is_new: flag,
    is_stale: flag,
  }),
  new_count: count,
});

export const mcpTrustScoreSchema = looseObject({
  window_days: count,
  count: count,
  tools: looseList({
    server: text,
    tool: text,
    ref: text,
    trust_score: count,
    grade: text,
    risk_level: text,
    calls: count,
    errors: count,
    error_rate_pct: count,
    distinct_users: count,
    confidence: text,
    last_seen: text,
  }),
});

/* ----------------------------------------------------------------- policies */

export const mcpPolicySchema = looseObject({
  server_label: text,
  mode: text,
  note: text,
  created_at: text,
  updated_at: text,
});
export type McpPolicy = z.output<typeof mcpPolicySchema>;

export const mcpPolicyListSchema = looseObject({
  policies: orDefault(z.array(mcpPolicySchema), [] as McpPolicy[]),
  allowlist_enabled: flag,
});

export const mcpPolicyWriteSchema = looseObject({
  policy: mcpPolicySchema.optional(),
  allowlist_enabled: z.boolean().optional(),
});

export const mcpPolicyDeleteSchema = looseObject({ server_label: text, status: text });

export const mcpEffectivePolicySchema = looseObject({
  server: text,
  tool: text,
  policy: looseObject({
    server_policy: text,
    allowlist_enabled: flag,
    tool_risk_level: text,
    tool_risk_action: text,
    tool_risk_configured: flag,
    tool_risk_note: text,
  }).optional(),
  final: looseObject({ decision: text, reason: text }).optional(),
});

export const mcpLoopSchema = looseObject({
  loops: looseList({
    session_id: text,
    server_label: text,
    tool_name: text,
    is_mcp: flag,
    calls: count,
    errors: count,
    api_key_id: text,
    first_seen: text,
    last_seen: text,
  }),
  threshold: count,
});

/* ----------------------------------------------------------- request log/flow */

export const mcpRequestSchema = looseObject({
  id: text,
  trace_id: text,
  api_key_id: text,
  model: text,
  provider: text,
  endpoint: text,
  status_code: count,
  latency_ms: count,
  tool_count: count,
  session_id: text,
  error: text,
  created_at: text,
});
export type McpRequest = z.output<typeof mcpRequestSchema>;

export const mcpRequestListSchema = looseObject({
  requests: orDefault(z.array(mcpRequestSchema), [] as McpRequest[]),
});

export const mcpWaterfallSchema = looseObject({
  request_id: text,
  trace_id: text,
  api_key_id: text,
  status: count,
  latency_ms: count,
  steps: orDefault(z.array(mcpFlowStepSchema), [] as McpFlowStep[]),
  tools: looseList({
    server_label: text,
    tool_name: text,
    is_mcp: flag,
    is_error: flag,
    created_at: text,
  }),
  route_decisions: z.array(unknownRecord).optional(),
});

export const mcpAgenticRunSchema = looseObject({
  request_id: text,
  agentic: flag,
  note: text,
});

export const mcpUpstreamFlowSchema = looseObject({
  upstream: mcpUpstreamSchema.optional(),
  routes: orDefault(z.array(mcpRouteSchema), [] as McpRoute[]),
  tool_stats: orDefault(z.array(mcpToolStatSchema), [] as McpToolStat[]),
  recent_requests: orDefault(z.array(mcpRequestSchema), [] as McpRequest[]),
  discovery_runs: orDefault(z.array(mcpDiscoveryRunSchema), [] as McpDiscoveryRun[]),
  discovery_error: text,
  policy: unknownRecord.optional(),
  final: looseObject({ decision: text, reason: text }).optional(),
  steps: orDefault(z.array(mcpFlowStepSchema), [] as McpFlowStep[]),
});

/* ------------------------------------------------------------ explain / test */

export const mcpRouteExplainSchema = looseObject({
  input: looseObject({ method: text, name: text, uri: text }).optional(),
  route: looseObject({
    found: flag,
    upstream_id: text,
    upstream_name: text,
    target_method: text,
    target_name: text,
    lookup: text,
  }).optional(),
  policy: looseObject({
    server_policy: text,
    tool_risk_level: text,
    tool_risk_action: text,
    tool_risk_configured: flag,
    tool_risk_note: text,
  }).optional(),
  final: looseObject({ decision: text, reason: text }).optional(),
});

export const mcpTestResultSchema = looseObject({
  upstream_id: text,
  upstream_name: text,
  method: text,
  latency_ms: count,
  ok: flag,
  error: text,
  response_preview: text,
  response: z.unknown().optional(),
});

/* ------------------------------------------------------------- gateway MCP */

export const gatewayMcpInfoSchema = looseObject({
  endpoint: text,
  protocol_version: text,
  note: text,
  tools: looseList({ name: text, description: text, inputSchema: z.unknown().optional() }),
  contracts: looseList({
    name: text,
    risk_level: text,
    cost_policy: text,
    timeout_ms: count,
    allowed_roles: text,
    executes: flag,
    output_schema: text,
  }),
  resources: looseList({ uri: text, name: text, description: text, mimeType: text }),
  prompts: looseList({ name: text, description: text }),
});

export const mcpContractSchema = looseObject({
  id: text,
  namespace: text,
  name: text,
  title: text,
  description: text,
  input_schema: text,
  output_schema: text,
  risk_level: text,
  timeout_ms: count,
  allowed_roles: text,
  cost_policy: text,
  owner: text,
  enabled: flag,
  created_by: text,
  updated_at: text,
});
export type McpContract = z.output<typeof mcpContractSchema>;

export const mcpContractListSchema = looseObject({
  contracts: orDefault(z.array(mcpContractSchema), [] as McpContract[]),
});

export const mcpContractWriteSchema = looseObject({ id: text, ok: flag });

export const mcpContractValidationSchema = looseObject({
  checked: count,
  drift_count: count,
  missing_count: count,
  note: text,
  results: looseList({
    contract_id: text,
    namespace: text,
    name: text,
    risk_level: text,
    status: text,
    detail: text,
    declared_only: textList,
    live_only: textList,
  }),
});

/* ------------------------------------------------------ agents / agent routes */

export const agentAnalyticsSchema = looseObject({
  since: text,
  agents: looseList({
    agent: text,
    requests: count,
    success_rate: count,
    fallback_rate: count,
    tokens: count,
    avg_cost_krw: count,
    total_cost_krw: count,
    avg_latency_ms: count,
    avg_first_chunk_ms: count,
    tool_calls: count,
    tool_errors: count,
    tool_error_rate: count,
    last_seen: text,
  }),
});

export const agentRouteSchema = looseObject({
  id: text,
  virtual_model: text,
  name: text,
  enabled: flag,
  backing_model: text,
  provider: text,
  provider_ref: text,
  mcp_upstreams: textList,
  allowed_tools: textList,
  system_prompt: text,
  max_steps: count,
  max_cost_krw: count,
  created_by: text,
  created_at: text,
  updated_at: text,
});
export type AgentRouteRow = z.output<typeof agentRouteSchema>;

export const agentRouteListSchema = looseObject({
  agent_routes: orDefault(z.array(agentRouteSchema), [] as AgentRouteRow[]),
  count: count,
  note: text,
});

export const agentRouteWriteSchema = looseObject({ agent_route: agentRouteSchema.optional() });

export const agentRouteDeleteSchema = looseObject({ id: text, deleted: flag });

export const agentRouteTestSchema = looseObject({
  status: count,
  ok: flag,
  prompt: text,
  content: text,
  backing_model: text,
  provider: text,
  provider_ref: text,
  tools: count,
  steps: count,
  tool_calls: count,
});

export const agentToolCatalogSchema = looseObject({
  tools: looseList({
    server_id: text,
    server_name: text,
    name: text,
    namespaced: text,
    description: text,
  }),
  count: count,
  errors: errorMap,
});

export const vcsEventListSchema = looseObject({
  events: looseList({
    id: text,
    provider: text,
    kind: text,
    repo: text,
    branch: text,
    ref: text,
    title: text,
    url: text,
    author_email: text,
    author_name: text,
    state: text,
    session_id: text,
    api_key_id: text,
    created_at: text,
  }),
});
