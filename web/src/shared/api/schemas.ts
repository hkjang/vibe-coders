import { z } from "zod";

import type {
  AdminStatsResponse as GeneratedAdminStatsResponse,
  AuthMeResponse as GeneratedAuthMeResponse,
  AuthTokenResponse as GeneratedAuthTokenResponse,
  AuthUser as GeneratedAuthUser,
  GetReadyErrors as GeneratedReadyErrors,
  HealthResponse as GeneratedHealthResponse,
  KeycloakLogoutResponse as GeneratedKeycloakLogoutResponse,
  MigrationFeature as GeneratedMigrationFeature,
  OpsRiskResponse as GeneratedOpsRiskResponse,
  OpsStatus as GeneratedOpsStatus,
  ReadyResponse as GeneratedReadyResponse,
  RoutingHealthResponse as GeneratedRoutingHealthResponse,
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

export const readinessSchema = z.object({
  status: z.literal("ready"),
}) satisfies z.ZodType<GeneratedReadyResponse>;

export const readinessFailureSchema = z.object({
  status: z.literal("not_ready"),
  error: z.string().min(1),
}) satisfies z.ZodType<GeneratedReadyErrors[503]>;

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

const countSchema = z.number().int().nonnegative();
const measurementSchema = z.number().nonnegative();
const percentageSchema = z.number().min(0).max(100);
const timestampSchema = z.string().datetime({ offset: true });

export const latencyQuantilesSchema = z.object({
  p50: countSchema,
  p95: countSchema,
  p99: countSchema,
});

export const groupedStatSchema = z.object({
  key: z.string(),
  requests: countSchema,
  tokens: countSchema,
  cost_krw: measurementSchema,
  average_latency_ms: measurementSchema,
});

export const languageStatSchema = z.object({
  language: z.string(),
  requests: countSchema,
  average_confidence: z.number().min(0).max(1),
});

export const requestStatusStatSchema = z.object({
  class: z.enum(["2xx", "3xx", "4xx", "quota", "5xx"]),
  requests: countSchema,
});

export const userSummarySchema = z.object({
  api_key_id: z.string(),
  name: z.string(),
  owner: z.string(),
  team: z.string(),
  status: z.string(),
  requests: countSchema,
  tokens: countSchema,
  cost_krw: measurementSchema,
  average_latency_ms: measurementSchema,
  last_seen: z.string(),
});

export const embeddingCacheStatsSchema = z.object({
  entries: countSchema,
  bytes: countSchema,
  total_hits: countSchema,
  top_models: z.array(
    z.object({
      model: z.string(),
      entries: countSchema,
      hits: countSchema,
    }),
  ),
});

export const adminStatsSchema = z.object({
  total_requests: countSchema,
  total_tokens: countSchema,
  total_cost_krw: measurementSchema,
  average_latency_ms: measurementSchema,
  by_ip: z.array(groupedStatSchema),
  by_model: z.array(groupedStatSchema),
  by_language: z.array(languageStatSchema),
  by_status: z.array(requestStatusStatSchema),
  top_users: z.array(userSummarySchema),
  latency_quantiles: latencyQuantilesSchema,
  first_chunk_quantiles: latencyQuantilesSchema,
  cache: embeddingCacheStatsSchema,
  failover_total: countSchema,
  cache_hits: countSchema,
  cache_misses: countSchema,
}) satisfies z.ZodType<GeneratedAdminStatsResponse>;

export const providerHealthScoreSchema = z.object({
  provider: z.string(),
  score: z.number().int().min(0).max(100),
  requests: countSchema,
  average_latency_ms: measurementSchema,
  p95_latency_ms: countSchema,
  timeouts: countSchema,
  rate_429: countSchema,
  rate_5xx: countSchema,
  fallbacks: countSchema,
  fallback_rate: z.number().min(0).max(1),
});

export const opsStatusSchema = z.object({
  generated_at: timestampSchema,
  providers: z.array(providerHealthScoreSchema),
  logging: z.object({
    queue_depth: countSchema,
    written: countSchema,
    dropped: countSchema,
  }),
  fallback: z.object({
    path: z.string(),
    exists: z.boolean(),
    lines: countSchema,
    bytes: countSchema,
    modified_at: z.union([z.literal(""), timestampSchema]),
  }),
  security: z.object({
    auth_enabled: z.boolean(),
    dev_secret: z.boolean(),
    raw_prompts_logged: z.boolean(),
    raw_bodies_logged: z.boolean(),
    pricing_configured: z.boolean(),
  }),
  disk: z.object({
    path: z.string(),
    available: z.boolean(),
    free_bytes: countSchema,
    total_bytes: countSchema,
    used_percent: percentageSchema,
  }),
  partial_failures: z
    .array(
      z.object({
        component: z.enum(["providers", "fallback"]),
        code: z.enum(["provider_health_unavailable", "fallback_stats_unavailable"]),
        message: z.string().min(1),
      }),
    )
    .optional(),
}) satisfies z.ZodType<GeneratedOpsStatus>;

export const opsRiskSchema = z.object({
  score: z.number().int().min(0).max(100),
  tier: z.enum(["low", "medium", "high", "critical"]),
  factors: z.array(
    z.object({
      key: z.string(),
      points: z.number().int().min(0).max(100),
      severity: z.enum(["info", "warning", "critical"]),
      message: z.string(),
    }),
  ),
});

export const opsRiskResponseSchema = z.object({
  risk: opsRiskSchema,
  status: opsStatusSchema,
}) satisfies z.ZodType<GeneratedOpsRiskResponse>;

const goDurationSchema = z
  .string()
  .trim()
  .regex(/^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/i);

export const routingHealthQuerySchema = z
  .object({
    window: z.union([z.enum(["1h", "6h", "24h", "1d", "7d", "30d"]), goDurationSchema]).optional(),
    threshold: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const routingHealthSchema = z.object({
  since: timestampSchema,
  until: timestampSchema,
  threshold: z.number().int().min(0).max(100),
  providers: z.array(providerHealthScoreSchema),
  ranking: z.array(
    z.object({
      rank: z.number().int().positive(),
      provider: z.string(),
      score: z.number().int().min(0).max(100),
      requests: countSchema,
      fallback_rate: z.number().min(0).max(1),
      p95_latency_ms: countSchema,
      average_latency_ms: measurementSchema,
    }),
  ),
  degraded: z.array(providerHealthScoreSchema),
  alerts: z.array(
    z.object({
      provider: z.string(),
      code: z.string(),
      severity: z.enum(["info", "warning", "critical"]),
      message: z.string(),
    }),
  ),
  trend: z.array(
    z.object({
      since: timestampSchema,
      until: timestampSchema,
      providers: z.array(providerHealthScoreSchema),
    }),
  ),
  breakers: z.object({
    enabled: z.boolean(),
    threshold: z.number().int().positive(),
    cooldown_seconds: countSchema,
    states: z.array(
      z.object({
        provider: z.string(),
        phase: z.enum(["closed", "open", "half_open"]),
        failures: countSchema,
        opens: countSchema,
        last_reason: z.string().optional(),
        last_failure_at: timestampSchema.optional(),
        opened_at: timestampSchema.optional(),
        retry_in_seconds: countSchema.optional(),
      }),
    ),
    shared: z.boolean(),
    instance_id: z.string(),
  }),
}) satisfies z.ZodType<GeneratedRoutingHealthResponse>;

export type AuthMe = z.output<typeof authMeSchema>;
export type AuthUser = z.output<typeof authUserSchema>;
export type AdminStats = z.output<typeof adminStatsSchema>;
export type GatewayHealth = z.output<typeof gatewayHealthSchema>;
export type OpsRisk = z.output<typeof opsRiskSchema>;
export type OpsRiskResponse = z.output<typeof opsRiskResponseSchema>;
export type OpsStatus = z.output<typeof opsStatusSchema>;
export type Readiness = z.output<typeof readinessSchema>;
export type ReadinessFailure = z.output<typeof readinessFailureSchema>;
export type RoutingHealth = z.output<typeof routingHealthSchema>;
export type RoutingHealthQuery = z.input<typeof routingHealthQuerySchema>;
export type SsoStatus = z.output<typeof ssoStatusSchema>;
export type TokenPair = z.output<typeof tokenPairSchema>;
export type UIBootstrap = z.output<typeof uiBootstrapSchema>;
export type UIBootstrapFeature = z.output<typeof migrationFeatureSchema>;
