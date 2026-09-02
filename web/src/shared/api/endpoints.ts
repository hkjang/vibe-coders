import { z } from "zod";

import type {
  GetAdminOpsRiskData,
  GetAdminOpsRiskResponse,
  GetAdminOpsStatusData,
  GetAdminOpsStatusResponse,
  GetAdminProvidersData,
  GetAdminProvidersSloData,
  GetAdminRoutingHealthData,
  GetAdminRoutingHealthResponse,
  GetAdminStatsData,
  GetAdminStatsResponse,
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
import type { OpenApiMethod, OpenApiMethodFor, OpenApiPath } from "@/shared/api/generated/paths.gen";
import {
  adminStatsSchema,
  authMeSchema,
  gatewayHealthSchema,
  logoutResponseSchema,
  opsRiskResponseSchema,
  opsStatusSchema,
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
import type { ProviderSLOQuery, RoutingHealthQuery } from "@/shared/api/schemas";

const endpointBrand: unique symbol = Symbol("api-endpoint");
declare const operationData: unique symbol;

interface OperationData {
  readonly url: OpenApiPath;
  readonly query?: object;
}

type WithQuery<Data extends OperationData, Query extends object> = Omit<Data, "query"> & {
  readonly query?: Query;
};

export interface ApiRoute<
  Data extends OperationData = OperationData,
  Method extends OpenApiMethod = OpenApiMethod,
> {
  readonly method: Method;
  readonly path: Data["url"];
  readonly [endpointBrand]: true;
  readonly [operationData]?: Data;
}

export interface ApiEndpoint<
  Data extends OperationData,
  Method extends OpenApiMethod = OpenApiMethod,
  Schema extends z.ZodType = z.ZodType,
> extends ApiRoute<Data, Method> {
  readonly schema: Schema;
  readonly querySchema?: z.ZodType<object>;
  readonly errorSchemas?: ApiEndpointErrorSchemas;
}

export type ApiEndpointErrorSchemas = Readonly<Partial<Record<number, z.ZodType>>>;

export interface ApiEndpointBase {
  readonly method: OpenApiMethod;
  readonly path: OpenApiPath;
  readonly schema: z.ZodType;
  readonly querySchema?: z.ZodType<object>;
  readonly errorSchemas?: ApiEndpointErrorSchemas;
  readonly [endpointBrand]: true;
}

export type ApiEndpointData<Endpoint extends ApiEndpointBase> =
  Endpoint extends ApiEndpoint<infer Data> ? Data : never;

export type ApiEndpointOutput<Endpoint extends ApiEndpointBase> = z.output<Endpoint["schema"]>;

function operation<Data extends OperationData, Response>() {
  return <Method extends OpenApiMethodFor<Data["url"]>, Schema extends z.ZodType<Response>>(
    method: Method,
    path: Data["url"],
    schema: Schema,
    querySchema?: z.ZodType<object>,
    errorSchemas?: ApiEndpointErrorSchemas,
  ): ApiEndpoint<Data, Method, Schema> => ({
    [endpointBrand]: true,
    method,
    path,
    schema,
    ...(querySchema ? { querySchema } : {}),
    ...(errorSchemas ? { errorSchemas } : {}),
  });
}

function route<Data extends OperationData>() {
  return <Method extends OpenApiMethodFor<Data["url"]>>(
    method: Method,
    path: Data["url"],
  ): ApiRoute<Data, Method> => ({ [endpointBrand]: true, method, path });
}

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
    providers: {
      list: operation<GetAdminProvidersData, unknown>()("GET", "/admin/providers", providerListSchema),
      slo: operation<WithQuery<GetAdminProvidersSloData, ProviderSLOQuery>, unknown>()(
        "GET",
        "/admin/providers/slo",
        providerSLOResponseSchema,
        providerSLOQuerySchema,
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
} as const;

type EndpointLeaves<Registry> = Registry extends ApiEndpointBase
  ? Registry
  : Registry extends ApiRoute
    ? never
    : Registry extends object
      ? { [Key in keyof Registry]: EndpointLeaves<Registry[Key]> }[keyof Registry]
      : never;

export type RegisteredApiEndpoint = EndpointLeaves<typeof endpoints>;
