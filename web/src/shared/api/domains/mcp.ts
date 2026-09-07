import { z } from "zod";

import {
  operation,
  pathWithParams,
  type ApiEndpointBase,
  type OperationData,
  type WithQuery,
} from "@/shared/api/endpoint-factory";
import type {
  DeleteAdminAgentRoutesIdData,
  DeleteAdminMcpContractsData,
  DeleteAdminMcpPoliciesServerData,
  DeleteAdminMcpUpstreamsIdData,
  GetAdminAgentRoutesData,
  GetAdminAgentRoutesToolCatalogData,
  GetAdminAgentsData,
  GetAdminGatewayMcpInfoData,
  GetAdminMcpAgenticRunsData,
  GetAdminMcpCatalogData,
  GetAdminMcpContractsData,
  GetAdminMcpEffectivePolicyData,
  GetAdminMcpLoopsData,
  GetAdminMcpOverviewData,
  GetAdminMcpPoliciesData,
  GetAdminMcpRequestsData,
  GetAdminMcpRequestsIdWaterfallData,
  GetAdminMcpRoutesData,
  GetAdminMcpServersData,
  GetAdminMcpToolsData,
  GetAdminMcpTopologyData,
  GetAdminMcpTrustScoresData,
  GetAdminMcpUpstreamsData,
  GetAdminMcpUpstreamsIdFlowData,
  GetAdminVcsEventsData,
  PostAdminAgentRoutesData,
  PostAdminAgentRoutesIdTestData,
  PostAdminMcpContractsData,
  PostAdminMcpContractsValidateData,
  PostAdminMcpOnboardingCheckData,
  PostAdminMcpPoliciesData,
  PostAdminMcpRouteExplainData,
  PostAdminMcpTestData,
  PostAdminMcpUpstreamsData,
} from "@/shared/api/generated";
import {
  agentAnalyticsSchema,
  agentRouteDeleteSchema,
  agentRouteListSchema,
  agentRouteTestSchema,
  agentRouteWriteSchema,
  agentToolCatalogSchema,
  gatewayMcpInfoSchema,
  mcpAgenticRunSchema,
  mcpCatalogSchema,
  mcpContractListSchema,
  mcpContractValidationSchema,
  mcpContractWriteSchema,
  mcpDeleteAcknowledgementSchema,
  mcpEffectivePolicySchema,
  mcpLoopSchema,
  mcpOverviewSchema,
  mcpPolicyDeleteSchema,
  mcpPolicyListSchema,
  mcpPolicyWriteSchema,
  mcpRequestListSchema,
  mcpRouteExplainSchema,
  mcpRouteListSchema,
  mcpServerListSchema,
  mcpTestResultSchema,
  mcpToolListSchema,
  mcpTopologySchema,
  mcpTrustScoreSchema,
  mcpUpstreamFlowSchema,
  mcpUpstreamListSchema,
  mcpUpstreamWriteSchema,
  mcpWaterfallSchema,
  onboardingChecklistSchema,
  onboardingRejectionSchema,
  vcsEventListSchema,
} from "@/shared/api/domains/mcp.schemas";

/**
 * Replaces the generated (usually `never`) request body with the shape the legacy
 * handler actually decodes; the Go handler struct is the contract because the
 * OpenAPI document carries no request schema for these operations.
 */
type WithBody<Data extends OperationData, Body> = Omit<Data, "body"> & { readonly body: Body };

/** Substitutes `{id}`-style path parameters just before the call. */
export function withMcpPathParams<Endpoint extends ApiEndpointBase>(
  endpoint: Endpoint,
  params: Readonly<Record<string, string | number>>,
): Endpoint {
  return { ...endpoint, path: pathWithParams(endpoint.path, params) } as Endpoint;
}

/* ----------------------------------------------------------------- queries */

const mcpFilterQuerySchema = z.object({
  server: z.string().optional(),
  tool: z.string().optional(),
  api_key_id: z.string().optional(),
  mcp_only: z.literal("1").optional(),
  window: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type McpFilterQuery = z.infer<typeof mcpFilterQuerySchema>;

const mcpToolQuerySchema = mcpFilterQuerySchema.extend({
  risk_level: z.string().optional(),
  action: z.string().optional(),
  configured: z.enum(["true", "false"]).optional(),
});
export type McpToolQuery = z.infer<typeof mcpToolQuerySchema>;

const mcpCatalogQuerySchema = z.object({ server: z.string().optional() });
export type McpCatalogQuery = z.infer<typeof mcpCatalogQuerySchema>;

const mcpLoopQuerySchema = z.object({
  window: z.string().optional(),
  threshold: z.number().int().positive().max(1_000).optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type McpLoopQuery = z.infer<typeof mcpLoopQuerySchema>;

const mcpEffectivePolicyQuerySchema = z.object({
  server: z.string(),
  tool: z.string().optional(),
});
export type McpEffectivePolicyQuery = z.infer<typeof mcpEffectivePolicyQuerySchema>;

const mcpRequestQuerySchema = z.object({
  server: z.string().optional(),
  tool: z.string().optional(),
  errors: z.literal("1").optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type McpRequestQuery = z.infer<typeof mcpRequestQuerySchema>;

const mcpTrustQuerySchema = z.object({ days: z.number().int().positive().max(365).optional() });
export type McpTrustQuery = z.infer<typeof mcpTrustQuerySchema>;

const mcpAgenticQuerySchema = z.object({ request_id: z.string() });
export type McpAgenticQuery = z.infer<typeof mcpAgenticQuerySchema>;

const mcpUpstreamWriteQuerySchema = z.object({ force: z.literal("1").optional() });
export type McpUpstreamWriteQuery = z.infer<typeof mcpUpstreamWriteQuerySchema>;

const mcpContractQuerySchema = z.object({
  namespace: z.string().optional(),
  enabled: z.literal("1").optional(),
});
export type McpContractQuery = z.infer<typeof mcpContractQuerySchema>;

const mcpContractDeleteQuerySchema = z.object({ id: z.string() });
export type McpContractDeleteQuery = z.infer<typeof mcpContractDeleteQuerySchema>;

const agentWindowQuerySchema = z.object({ window: z.string().optional() });
export type AgentWindowQuery = z.infer<typeof agentWindowQuerySchema>;

const agentToolCatalogQuerySchema = z.object({ upstream: z.array(z.string()).optional() });
export type AgentToolCatalogQuery = z.infer<typeof agentToolCatalogQuerySchema>;

const vcsEventQuerySchema = z.object({
  repo: z.string().optional(),
  session_id: z.string().optional(),
  api_key_id: z.string().optional(),
  kind: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type VcsEventQuery = z.infer<typeof vcsEventQuerySchema>;

/* ------------------------------------------------------------ request bodies */

export interface McpUpstreamMetadataBody {
  description?: string;
  domains?: readonly string[];
  risk_level?: string;
  allowed_models?: readonly string[];
  default_tool?: string;
  timeout_ms?: number;
  max_results?: number;
  requires_approval?: boolean;
  fallback_allowed?: boolean;
}

export interface McpUpstreamBody {
  id?: string;
  name: string;
  url: string;
  /** Write-only bearer token; the server never returns it. */
  auth_token?: string;
  enabled?: boolean;
  metadata?: McpUpstreamMetadataBody;
}

export interface McpPolicyBody {
  server_label?: string;
  mode?: string;
  note?: string;
  allowlist_enabled?: boolean;
}

export interface McpRouteExplainBody {
  method?: string;
  name?: string;
  uri?: string;
}

export interface McpTestBody {
  upstream_id?: string;
  method: string;
  name?: string;
  uri?: string;
  arguments?: unknown;
}

export interface McpContractBody {
  id?: string;
  namespace?: string;
  name: string;
  title?: string;
  description?: string;
  input_schema?: string;
  output_schema?: string;
  risk_level?: string;
  timeout_ms?: number;
  allowed_roles?: string;
  cost_policy?: string;
  owner?: string;
  enabled?: boolean;
}

export interface McpContractValidateBody {
  namespace?: string;
  contract_id?: string;
}

export interface AgentRouteBody {
  id?: string;
  virtual_model: string;
  name?: string;
  enabled?: boolean;
  backing_model?: string;
  provider?: string;
  mcp_upstreams?: readonly string[];
  allowed_tools?: readonly string[];
  system_prompt?: string;
  max_steps?: number;
  max_cost_krw?: number;
}

export interface AgentRouteTestBody {
  prompt?: string;
}

/* --------------------------------------------------------------- endpoints */

export const mcpEndpoints = {
  overview: operation<GetAdminMcpOverviewData, unknown>()("GET", "/admin/mcp/overview", mcpOverviewSchema),
  routes: operation<GetAdminMcpRoutesData, unknown>()("GET", "/admin/mcp/routes", mcpRouteListSchema),
  topology: operation<GetAdminMcpTopologyData, unknown>()("GET", "/admin/mcp/topology", mcpTopologySchema),
  servers: operation<WithQuery<GetAdminMcpServersData, McpFilterQuery>, unknown>()(
    "GET",
    "/admin/mcp/servers",
    mcpServerListSchema,
    mcpFilterQuerySchema,
  ),
  tools: operation<WithQuery<GetAdminMcpToolsData, McpToolQuery>, unknown>()(
    "GET",
    "/admin/mcp/tools",
    mcpToolListSchema,
    mcpToolQuerySchema,
  ),
  catalog: operation<WithQuery<GetAdminMcpCatalogData, McpCatalogQuery>, unknown>()(
    "GET",
    "/admin/mcp/catalog",
    mcpCatalogSchema,
    mcpCatalogQuerySchema,
  ),
  trustScores: operation<WithQuery<GetAdminMcpTrustScoresData, McpTrustQuery>, unknown>()(
    "GET",
    "/admin/mcp/trust-scores",
    mcpTrustScoreSchema,
    mcpTrustQuerySchema,
  ),
  policies: operation<GetAdminMcpPoliciesData, unknown>()("GET", "/admin/mcp/policies", mcpPolicyListSchema),
  savePolicy: operation<WithBody<PostAdminMcpPoliciesData, McpPolicyBody>, unknown>()(
    "POST",
    "/admin/mcp/policies",
    mcpPolicyWriteSchema,
  ),
  deletePolicy: operation<DeleteAdminMcpPoliciesServerData, unknown>()(
    "DELETE",
    "/admin/mcp/policies/{server}",
    mcpPolicyDeleteSchema,
  ),
  effectivePolicy: operation<WithQuery<GetAdminMcpEffectivePolicyData, McpEffectivePolicyQuery>, unknown>()(
    "GET",
    "/admin/mcp/effective-policy",
    mcpEffectivePolicySchema,
    mcpEffectivePolicyQuerySchema,
  ),
  loops: operation<WithQuery<GetAdminMcpLoopsData, McpLoopQuery>, unknown>()(
    "GET",
    "/admin/mcp/loops",
    mcpLoopSchema,
    mcpLoopQuerySchema,
  ),
  upstreams: operation<GetAdminMcpUpstreamsData, unknown>()(
    "GET",
    "/admin/mcp/upstreams",
    mcpUpstreamListSchema,
  ),
  saveUpstream: operation<
    WithQuery<WithBody<PostAdminMcpUpstreamsData, McpUpstreamBody>, McpUpstreamWriteQuery>,
    unknown
  >()("POST", "/admin/mcp/upstreams", mcpUpstreamWriteSchema, mcpUpstreamWriteQuerySchema, {
    422: onboardingRejectionSchema,
  }),
  deleteUpstream: operation<DeleteAdminMcpUpstreamsIdData, unknown>()(
    "DELETE",
    "/admin/mcp/upstreams/{id}",
    mcpDeleteAcknowledgementSchema,
  ),
  upstreamFlow: operation<GetAdminMcpUpstreamsIdFlowData, unknown>()(
    "GET",
    "/admin/mcp/upstreams/{id}/flow",
    mcpUpstreamFlowSchema,
  ),
  onboardingCheck: operation<WithBody<PostAdminMcpOnboardingCheckData, McpUpstreamBody>, unknown>()(
    "POST",
    "/admin/mcp/onboarding-check",
    onboardingChecklistSchema,
  ),
  requests: operation<WithQuery<GetAdminMcpRequestsData, McpRequestQuery>, unknown>()(
    "GET",
    "/admin/mcp/requests",
    mcpRequestListSchema,
    mcpRequestQuerySchema,
  ),
  requestWaterfall: operation<GetAdminMcpRequestsIdWaterfallData, unknown>()(
    "GET",
    "/admin/mcp/requests/{id}/waterfall",
    mcpWaterfallSchema,
  ),
  agenticRuns: operation<WithQuery<GetAdminMcpAgenticRunsData, McpAgenticQuery>, unknown>()(
    "GET",
    "/admin/mcp/agentic-runs",
    mcpAgenticRunSchema,
    mcpAgenticQuerySchema,
  ),
  routeExplain: operation<WithBody<PostAdminMcpRouteExplainData, McpRouteExplainBody>, unknown>()(
    "POST",
    "/admin/mcp/route/explain",
    mcpRouteExplainSchema,
  ),
  test: operation<WithBody<PostAdminMcpTestData, McpTestBody>, unknown>()(
    "POST",
    "/admin/mcp/test",
    mcpTestResultSchema,
  ),
  gateway: {
    info: operation<GetAdminGatewayMcpInfoData, unknown>()(
      "GET",
      "/admin/gateway-mcp/info",
      gatewayMcpInfoSchema,
    ),
    contracts: operation<WithQuery<GetAdminMcpContractsData, McpContractQuery>, unknown>()(
      "GET",
      "/admin/mcp/contracts",
      mcpContractListSchema,
      mcpContractQuerySchema,
    ),
    saveContract: operation<WithBody<PostAdminMcpContractsData, McpContractBody>, unknown>()(
      "POST",
      "/admin/mcp/contracts",
      mcpContractWriteSchema,
    ),
    deleteContract: operation<WithQuery<DeleteAdminMcpContractsData, McpContractDeleteQuery>, unknown>()(
      "DELETE",
      "/admin/mcp/contracts",
      mcpContractWriteSchema,
      mcpContractDeleteQuerySchema,
    ),
    validateContracts: operation<
      WithBody<PostAdminMcpContractsValidateData, McpContractValidateBody>,
      unknown
    >()("POST", "/admin/mcp/contracts/validate", mcpContractValidationSchema),
  },
  agents: {
    analytics: operation<WithQuery<GetAdminAgentsData, AgentWindowQuery>, unknown>()(
      "GET",
      "/admin/agents",
      agentAnalyticsSchema,
      agentWindowQuerySchema,
    ),
    routes: operation<GetAdminAgentRoutesData, unknown>()("GET", "/admin/agent-routes", agentRouteListSchema),
    saveRoute: operation<WithBody<PostAdminAgentRoutesData, AgentRouteBody>, unknown>()(
      "POST",
      "/admin/agent-routes",
      agentRouteWriteSchema,
    ),
    deleteRoute: operation<DeleteAdminAgentRoutesIdData, unknown>()(
      "DELETE",
      "/admin/agent-routes/{id}",
      agentRouteDeleteSchema,
    ),
    testRoute: operation<WithBody<PostAdminAgentRoutesIdTestData, AgentRouteTestBody>, unknown>()(
      "POST",
      "/admin/agent-routes/{id}/test",
      agentRouteTestSchema,
    ),
    toolCatalog: operation<WithQuery<GetAdminAgentRoutesToolCatalogData, AgentToolCatalogQuery>, unknown>()(
      "GET",
      "/admin/agent-routes/tool-catalog",
      agentToolCatalogSchema,
      agentToolCatalogQuerySchema,
    ),
    vcsEvents: operation<WithQuery<GetAdminVcsEventsData, VcsEventQuery>, unknown>()(
      "GET",
      "/admin/vcs/events",
      vcsEventListSchema,
      vcsEventQuerySchema,
    ),
  },
} as const;
