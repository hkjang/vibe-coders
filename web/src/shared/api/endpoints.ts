import { z } from "zod";

import type {
  GetAdminUiBootstrapData,
  GetAdminUiBootstrapResponse,
  GetAuthKeycloakLoginData,
  GetAuthMeData,
  GetAuthMeResponse,
  GetAuthSsoStatusData,
  GetAuthSsoStatusResponse,
  GetHealthData,
  GetHealthResponse,
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
  authMeSchema,
  gatewayHealthSchema,
  logoutResponseSchema,
  ssoStatusSchema,
  tokenPairSchema,
  uiBootstrapSchema,
} from "@/shared/api/schemas";

const endpointBrand: unique symbol = Symbol("api-endpoint");
declare const operationData: unique symbol;

interface OperationData {
  readonly url: OpenApiPath;
}

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
}

export interface ApiEndpointBase {
  readonly method: OpenApiMethod;
  readonly path: OpenApiPath;
  readonly schema: z.ZodType;
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
  ): ApiEndpoint<Data, Method, Schema> => ({ [endpointBrand]: true, method, path, schema });
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
} as const;

type EndpointLeaves<Registry> = Registry extends ApiEndpointBase
  ? Registry
  : Registry extends ApiRoute
    ? never
    : Registry extends object
      ? { [Key in keyof Registry]: EndpointLeaves<Registry[Key]> }[keyof Registry]
      : never;

export type RegisteredApiEndpoint = EndpointLeaves<typeof endpoints>;
