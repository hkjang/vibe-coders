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

const mcpTopologyNodeSchema = looseObject({
  id: z.string().min(1),
  label: z.string(),
  kind: z.string().min(1),
  status: text,
  decision: text,
});
const mcpTopologyEdgeSchema = looseObject({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string(),
});
export const mcpTopologySchema = looseObject({
  nodes: z.array(mcpTopologyNodeSchema),
  edges: z.array(mcpTopologyEdgeSchema),
}).refine((value) => new Set(value.nodes.map((node) => node.id)).size === value.nodes.length, {
  message: "연결 구조의 노드 ID가 중복되어 대상을 구분할 수 없습니다.",
});
export type McpTopology = z.output<typeof mcpTopologySchema>;
export type McpTopologyNode = z.output<typeof mcpTopologyNodeSchema>;

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
  server_label: z.string().min(1),
  mode: z.string().min(1),
  note: z.string(),
  created_at: text,
  updated_at: text,
});
export type McpPolicy = z.output<typeof mcpPolicySchema>;

export const mcpPolicyListSchema = looseObject({
  policies: z.array(mcpPolicySchema),
  allowlist_enabled: z.boolean(),
}).refine((value) => new Set(value.policies.map((row) => row.server_label)).size === value.policies.length, {
  message: "서버 정책의 고유한 대상을 확인할 수 없습니다.",
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

export const mcpRouteExplainSchema = z
  .object({
    input: z.object({ method: z.string(), name: z.string(), uri: z.string() }).passthrough(),
    route: z
      .object({
        found: z.boolean(),
        upstream_id: z.string().optional(),
        upstream_name: z.string().optional(),
        target_method: z.string().optional(),
        target_name: z.string().optional(),
        lookup: z.string().optional(),
      })
      .passthrough(),
    policy: z
      .object({
        server_policy: z.string().min(1),
        tool_risk_level: z.string().min(1),
        tool_risk_action: z.string().min(1),
        tool_risk_configured: z.boolean(),
        tool_risk_note: z.string(),
      })
      .passthrough()
      .optional(),
    final: z.object({ decision: z.string().min(1), reason: z.string() }).passthrough(),
  })
  .passthrough()
  .refine(
    (value) =>
      !value.route.found ||
      Boolean(
        value.route.upstream_id && value.route.upstream_name && value.route.target_method && value.policy,
      ),
  );

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
  endpoint: z.string().min(1),
  protocol_version: z.string().min(1),
  note: z.string(),
  tools: z.array(
    looseObject({
      name: z.string().min(1),
      description: z.string().default(""),
      inputSchema: z.unknown().optional(),
    }),
  ),
  contracts: z.array(
    looseObject({
      name: z.string().min(1),
      risk_level: z.string(),
      cost_policy: z.string(),
      timeout_ms: z.number().int().safe(),
      allowed_roles: z.string(),
      executes: z.boolean(),
      output_schema: z.string(),
    }),
  ),
  resources: z.array(
    looseObject({
      uri: z.string(),
      name: z.string(),
      description: z.string().default(""),
      mimeType: z.string().default(""),
    }),
  ),
  prompts: z.array(looseObject({ name: z.string(), description: z.string().default("") })),
});

export const mcpContractSchema = looseObject({
  id: z.string().min(1),
  namespace: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  input_schema: z.string(),
  output_schema: z.string(),
  risk_level: z.string(),
  timeout_ms: z.number().int().safe(),
  allowed_roles: z.string(),
  cost_policy: z.string(),
  owner: z.string(),
  enabled: z.boolean(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type McpContract = z.output<typeof mcpContractSchema>;

export const mcpContractListSchema = looseObject({
  contracts: z
    .array(mcpContractSchema)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, "Duplicate contract IDs"),
});

export const mcpContractWriteSchema = looseObject({ id: z.string().min(1), ok: z.literal(true) });
export const mcpContractDeletedSchema = looseObject({ ok: z.literal(true) });

export const mcpContractValidationSchema = looseObject({
  checked: z.number().int().nonnegative(),
  drift_count: z.number().int().nonnegative(),
  missing_count: z.number().int().nonnegative(),
  note: z.string(),
  results: z.array(
    looseObject({
      contract_id: z.string(),
      namespace: z.string(),
      name: z.string(),
      risk_level: z.string(),
      status: z.string(),
      detail: z.string().default(""),
      declared_only: z.array(z.string()).default([]),
      live_only: z.array(z.string()).default([]),
    }),
  ),
}).refine(
  (value) =>
    value.checked === value.results.length &&
    value.drift_count === value.results.filter((row) => row.status === "drift").length &&
    value.missing_count === value.results.filter((row) => row.status === "missing").length,
  "Inconsistent contract validation counts",
);

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
