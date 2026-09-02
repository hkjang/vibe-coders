import { z } from "zod";

import type {
  AuthMeResponse as GeneratedAuthMeResponse,
  AuthTokenResponse as GeneratedAuthTokenResponse,
  AuthUser as GeneratedAuthUser,
  HealthResponse as GeneratedHealthResponse,
  KeycloakLogoutResponse as GeneratedKeycloakLogoutResponse,
  MigrationFeature as GeneratedMigrationFeature,
  SsoStatusResponse as GeneratedSsoStatusResponse,
  UiBootstrapResponse as GeneratedUiBootstrapResponse,
} from "@/shared/api/generated";

export const authUserSchema = z.object({
  id: z.string(),
  email: z.string().default(""),
  name: z.string().optional(),
  role: z.string(),
  roles: z.array(z.string()).default([]),
  team_id: z.string().default(""),
  cost_center: z.string().optional(),
  scopes: z.array(z.string()).default([]),
  features: z.record(z.string(), z.boolean()).default({}),
  default_home: z.string().optional(),
}) satisfies z.ZodType<GeneratedAuthUser>;

export const tokenUserSchema = authUserSchema;

export const tokenPairSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number(),
  refresh_expires_in: z.number(),
  user: tokenUserSchema.optional(),
}) satisfies z.ZodType<GeneratedAuthTokenResponse>;

export const authMeSchema = z.object({
  auth_enabled: z.boolean(),
  version: z.string(),
  expires_at: z.number().optional(),
  menu_version: z.number().optional(),
  user: authUserSchema.optional(),
}) satisfies z.ZodType<GeneratedAuthMeResponse>;

export const ssoStatusSchema = z.object({
  keycloak_enabled: z.boolean(),
  allow_local_login: z.boolean(),
  login_url: z.string(),
}) satisfies z.ZodType<GeneratedSsoStatusResponse>;

export const logoutResponseSchema = z.object({
  status: z.literal("logged_out"),
  end_session_url: z.string(),
}) satisfies z.ZodType<GeneratedKeycloakLogoutResponse>;

export const gatewayHealthSchema = z.object({
  status: z.literal("ok"),
}) satisfies z.ZodType<GeneratedHealthResponse>;

export const openAIErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    param: z.unknown().nullable().optional(),
    code: z.string().nullable().optional(),
  }),
  request_id: z.string().optional(),
});

export const navigationSchema = z.object({
  allowed_tabs: z.array(z.string()),
  default_home: z.string(),
  role: z.string(),
  scopes: z.array(z.string()),
  features: z.record(z.string(), z.boolean()),
  menu_version: z.number(),
  menus: z.array(z.record(z.string(), z.unknown())),
});

export const migrationStatusSchema = z.enum([
  "hidden",
  "legacy",
  "preview_read_only",
  "preview",
  "stable",
  "deprecated",
  "retired",
]);

export const migrationFeatureSchema = z.object({
  feature_id: z.string(),
  title: z.string(),
  app_path: z.string().refine((value) => value === "/app" || value.startsWith("/app/")),
  legacy_path: z.string().startsWith("/admin"),
  status: migrationStatusSchema,
  risk_level: z.enum(["low", "medium", "high", "critical"]),
  required_permission: z.string(),
  read_only: z.boolean(),
  enabled_roles: z.array(z.string()),
  rollout_percent: z.number().int().min(0).max(100),
  fallback_enabled: z.boolean(),
  minimum_api_version: z.string(),
  available: z.boolean(),
  availability_reason: z.string().optional(),
}) satisfies z.ZodType<GeneratedMigrationFeature>;

export const uiBootstrapSchema = z.object({
  backend_version: z.string(),
  ui_version: z.string(),
  api_version: z.string(),
  ui: z.object({
    enabled: z.boolean(),
    default_entry: z.string(),
    legacy_fallback: z.boolean(),
    feedback_enabled: z.boolean(),
    telemetry_enabled: z.boolean(),
  }),
  authentication: z.object({
    enabled: z.boolean(),
    authenticated: z.boolean(),
    mode: z.enum(["open", "session", "legacy_token"]),
    keycloak_enabled: z.boolean(),
    allow_local_login: z.boolean(),
    sso_login_url: z.string(),
  }),
  user: authUserSchema.nullable().optional(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  allowed_features: z.array(z.string()),
  migration_registry: z.array(migrationFeatureSchema),
  system_status: z.object({ status: z.enum(["healthy", "degraded"]) }),
  legacy_route_map: z.record(z.string(), z.string()),
}) satisfies z.ZodType<GeneratedUiBootstrapResponse>;

export type AuthMe = z.output<typeof authMeSchema>;
export type AuthUser = z.output<typeof authUserSchema>;
export type SsoStatus = z.output<typeof ssoStatusSchema>;
export type TokenPair = z.output<typeof tokenPairSchema>;
export type UIBootstrap = z.output<typeof uiBootstrapSchema>;
export type UIBootstrapFeature = z.output<typeof migrationFeatureSchema>;
