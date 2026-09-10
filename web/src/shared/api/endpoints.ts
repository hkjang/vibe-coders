import { z } from "zod";

import type {
  AppRequestsResponse,
  GetAdminModelsData,
  GetAdminModelsQualityData,
  GetAdminModelsQualityResponse,
  GetAdminModelsResponse,
  GetAdminRequestsData,
  GetAdminModelTagsData,
  GetAdminModelTagsResponse,
  GetAdminOpsRiskData,
  GetAdminOpsRiskResponse,
  GetAdminOpsStatusData,
  GetAdminOpsStatusResponse,
  GetAdminProvidersData,
  GetAdminProvidersResponse,
  GetAdminProvidersSloData,
  GetAdminProvidersSloResponse,
  GetAdminPricingData,
  GetAdminPricingResponse,
  GetAdminRoutingHealthData,
  GetAdminRoutingHealthResponse,
  GetAdminHeatmapData,
  GetAdminStatsData,
  GetAdminStatsResponse,
  GetAdminTimeseriesData,
  GetAdminUiBootstrapData,
  GetAdminUiBootstrapResponse,
  GetAuthKeycloakLoginData,
  GetAuthMeData,
  GetAuthMeResponse,
  GetAuthSsoStatusData,
  GetAuthSsoStatusResponse,
  GetHealthData,
  GetHealthResponse,
  GetReadyData,
  GetReadyResponse,
  PostAuthKeycloakLogoutData,
  PostAuthKeycloakLogoutResponse,
  PostAuthLoginData,
  PostAuthLoginResponse,
  PostAuthLogoutData,
  PostAuthLogoutResponse,
  PostAuthRefreshData,
  PostAuthRefreshResponse,
  PostAuthSsoExchangeData,
  PostAuthSsoExchangeResponse,
} from "@/shared/api/generated";
import {
  operation,
  route,
  type ApiEndpointBase,
  type ApiRoute,
  type EndpointLeaves,
  type WithQuery,
} from "@/shared/api/endpoint-factory";
import { accessEndpoints } from "@/shared/api/domains/access";
import { agentsEndpoints } from "@/shared/api/domains/agents";
import { dataEndpoints } from "@/shared/api/domains/data";
import { finopsEndpoints } from "@/shared/api/domains/finops";
import { gatewayEndpoints } from "@/shared/api/domains/gateway";
import { governanceEndpoints } from "@/shared/api/domains/governance";
import { governanceReportsEndpoints } from "@/shared/api/domains/governance-reports";
import { mcpEndpoints } from "@/shared/api/domains/mcp";
import { observabilityEndpoints } from "@/shared/api/domains/observability";
import { promptsEndpoints } from "@/shared/api/domains/prompts";
import { redteamEndpoints } from "@/shared/api/domains/redteam";
import { routingEndpoints } from "@/shared/api/domains/routing";
import { securityEndpoints } from "@/shared/api/domains/security";
import { systemEndpoints } from "@/shared/api/domains/system";
import { text2sqlEndpoints } from "@/shared/api/domains/text2sql";
import {
  adminModelsQuerySchema,
  adminModelsResponseSchema,
  appRequestsQuerySchema,
  appRequestsResponseSchema,
  adminHeatmapSchema,
  adminStatsSchema,
  adminTimeseriesSchema,
  authMeSchema,
  gatewayHealthSchema,
  logoutResponseSchema,
  heatmapQuerySchema,
  modelQualityQuerySchema,
  modelQualityResponseSchema,
  modelUsageTagsResponseSchema,
  timeseriesQuerySchema,
  type TimeseriesQuery,
  opsRiskResponseSchema,
  opsStatusSchema,
  pricingQuerySchema,
  pricingResponseSchema,
  providerListSchema,
  providerSLOQuerySchema,
  providerSLOResponseSchema,
  readinessFailureSchema,
  readinessSchema,
  routingHealthQuerySchema,
  routingHealthSchema,
  ssoStatusSchema,
  tokenPairSchema,
  uiBootstrapSchema,
} from "@/shared/api/schemas";
import type {
  AdminModelsQuery,
  AppRequestsQuery,
  ModelQualityQuery,
  PricingQuery,
  ProviderSLOQuery,
  RoutingHealthQuery,
} from "@/shared/api/schemas";

export type {
  ApiEndpoint,
  ApiEndpointBase,
  ApiEndpointData,
  ApiEndpointErrorSchemas,
  ApiEndpointOutput,
  ApiRoute,
  WithQuery,
} from "@/shared/api/endpoint-factory";

const statusResponseSchema = z.object({ status: z.string() }) satisfies z.ZodType<PostAuthLogoutResponse>;

export const endpoints = {
  health: operation<GetHealthData, GetHealthResponse>()("GET", "/health", gatewayHealthSchema),
  ready: operation<GetReadyData, GetReadyResponse>()("GET", "/ready", readinessSchema, undefined, {
    503: readinessFailureSchema,
  }),
  auth: {
    login: operation<PostAuthLoginData, PostAuthLoginResponse>()("POST", "/auth/login", tokenPairSchema),
    logout: operation<PostAuthLogoutData, PostAuthLogoutResponse>()(
      "POST",
      "/auth/logout",
      statusResponseSchema,
    ),
    refresh: operation<PostAuthRefreshData, PostAuthRefreshResponse>()(
      "POST",
      "/auth/refresh",
      tokenPairSchema,
    ),
    ssoExchange: operation<PostAuthSsoExchangeData, PostAuthSsoExchangeResponse>()(
      "POST",
      "/auth/sso/exchange",
      tokenPairSchema,
    ),
    me: operation<GetAuthMeData, GetAuthMeResponse>()("GET", "/auth/me", authMeSchema),
    ssoStatus: operation<GetAuthSsoStatusData, GetAuthSsoStatusResponse>()(
      "GET",
      "/auth/sso/status",
      ssoStatusSchema,
    ),
    keycloakLogin: route<GetAuthKeycloakLoginData>()("GET", "/auth/keycloak/login"),
    keycloakLogout: operation<PostAuthKeycloakLogoutData, PostAuthKeycloakLogoutResponse>()(
      "POST",
      "/auth/keycloak/logout",
      logoutResponseSchema,
    ),
  },
  uiBootstrap: operation<GetAdminUiBootstrapData, GetAdminUiBootstrapResponse>()(
    "GET",
    "/admin/ui-bootstrap",
    uiBootstrapSchema,
  ),
  admin: {
    stats: operation<GetAdminStatsData, GetAdminStatsResponse>()("GET", "/admin/stats", adminStatsSchema),
    // The dashboard's two chart sources: totals over time and the weekday/hour heatmap.
    timeseries: operation<WithQuery<GetAdminTimeseriesData, TimeseriesQuery>, unknown>()(
      "GET",
      "/admin/timeseries",
      adminTimeseriesSchema,
      timeseriesQuerySchema,
    ),
    heatmap: operation<WithQuery<GetAdminHeatmapData, { window: string }>, unknown>()(
      "GET",
      "/admin/heatmap",
      adminHeatmapSchema,
      heatmapQuerySchema,
    ),
    requests: operation<WithQuery<GetAdminRequestsData, AppRequestsQuery>, AppRequestsResponse>()(
      "GET",
      "/admin/requests",
      appRequestsResponseSchema,
      appRequestsQuerySchema,
    ),
    providers: {
      list: operation<GetAdminProvidersData, GetAdminProvidersResponse>()(
        "GET",
        "/admin/providers",
        providerListSchema,
      ),
      slo: operation<WithQuery<GetAdminProvidersSloData, ProviderSLOQuery>, GetAdminProvidersSloResponse>()(
        "GET",
        "/admin/providers/slo",
        providerSLOResponseSchema,
        providerSLOQuerySchema,
      ),
    },
    models: {
      list: operation<WithQuery<GetAdminModelsData, AdminModelsQuery>, GetAdminModelsResponse>()(
        "GET",
        "/admin/models",
        adminModelsResponseSchema,
        adminModelsQuerySchema,
      ),
      quality: operation<
        WithQuery<GetAdminModelsQualityData, ModelQualityQuery>,
        GetAdminModelsQualityResponse
      >()("GET", "/admin/models/quality", modelQualityResponseSchema, modelQualityQuerySchema),
      pricing: operation<WithQuery<GetAdminPricingData, PricingQuery>, GetAdminPricingResponse>()(
        "GET",
        "/admin/pricing",
        pricingResponseSchema,
        pricingQuerySchema,
      ),
      tags: operation<GetAdminModelTagsData, GetAdminModelTagsResponse>()(
        "GET",
        "/admin/model-tags",
        modelUsageTagsResponseSchema,
      ),
    },
    ops: {
      status: operation<GetAdminOpsStatusData, GetAdminOpsStatusResponse>()(
        "GET",
        "/admin/ops/status",
        opsStatusSchema,
      ),
      risk: operation<GetAdminOpsRiskData, GetAdminOpsRiskResponse>()(
        "GET",
        "/admin/ops/risk",
        opsRiskResponseSchema,
      ),
    },
    routing: {
      health: operation<
        WithQuery<GetAdminRoutingHealthData, RoutingHealthQuery>,
        GetAdminRoutingHealthResponse
      >()("GET", "/admin/routing/health", routingHealthSchema, routingHealthQuerySchema),
    },
  },
  // Domain registries: one file per console domain under "@/shared/api/domains".
  domains: {
    access: accessEndpoints,
    agents: agentsEndpoints,
    data: dataEndpoints,
    finops: finopsEndpoints,
    gateway: gatewayEndpoints,
    governance: governanceEndpoints,
    governanceReports: governanceReportsEndpoints,
    mcp: mcpEndpoints,
    observability: observabilityEndpoints,
    prompts: promptsEndpoints,
    redteam: redteamEndpoints,
    routing: routingEndpoints,
    security: securityEndpoints,
    system: systemEndpoints,
    text2sql: text2sqlEndpoints,
  },
} as const;

export type RegisteredApiEndpoint = EndpointLeaves<typeof endpoints>;

// Keeps the imported types referenced for the re-export above under isolatedModules.
export type { ApiEndpointBase as RegisteredApiEndpointBase, ApiRoute as RegisteredApiRoute };
