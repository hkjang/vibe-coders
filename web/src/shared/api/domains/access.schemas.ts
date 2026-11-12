import { z } from "zod";

import { looseObject, numberish, orDefault, unknownRecord } from "@/shared/api/loose";

// Response contracts for the access domain. The legacy admin API documents its
// responses as `unknown`, so these schemas are the contract: only the fields the
// screens render are declared and everything else passes through untouched.

const text = z
  .string()
  .nullish()
  .transform((value) => value ?? "");
const count = orDefault(numberish, 0);
const ratio = orDefault(numberish, -1);
const stringList = orDefault(z.array(z.string()), []);

function list<Shape extends z.ZodRawShape>(shape: Shape) {
  return orDefault(z.array(z.looseObject(shape)), []);
}

/* ------------------------------------------------------------------ users */

export const userSummarySchema = looseObject({
  api_key_id: z.string(),
  name: text,
  owner: text,
  team: text,
  status: text,
  requests: count,
  tokens: count,
  cost_krw: count,
  average_latency_ms: count,
  last_seen: text,
});
export type UserSummary = z.output<typeof userSummarySchema>;

export const authUserSchema = looseObject({
  id: z.string(),
  email: text,
  name: text,
  role: text,
  status: text,
  team_id: text,
  created_at: text,
});
export type AuthUserRow = z.output<typeof authUserSchema>;

export const adminUsersSchema = looseObject({
  users: orDefault(z.array(userSummarySchema), []),
  auth_users: orDefault(z.array(authUserSchema), []),
  team_names: orDefault(z.record(z.string(), z.string()), {}),
});

export const adminUserMutationSchema = looseObject({
  user: authUserSchema.nullish(),
  team_id: text,
});

export const adminUserDetailSchema = looseObject({
  api_key: unknownRecord.nullish(),
  stats: unknownRecord.nullish(),
  advanced: unknownRecord.nullish(),
  by_status: list({ status: text, requests: count }),
  daily: list({ day: text, requests: count, tokens: count, cost_krw: count }),
  by_model: list({ model: text, requests: count, tokens: count, cost_krw: count }),
  by_language: list({ language: text, requests: count }),
  by_ip: list({ ip: text, requests: count }),
  recent: list({ id: text, model: text, status_code: count, cost_krw: count, created_at: text }),
  team_names: orDefault(z.record(z.string(), z.string()), {}),
});
export type AdminUserDetail = z.output<typeof adminUserDetailSchema>;

// GET /admin/users/{id}/report is a flat object, not wrapped in a envelope.
export const adminUserReportSchema = looseObject({
  api_key_id: text,
  name: text,
  owner: text,
  team: text,
  window_start: text,
  window_end: text,
  requests: count,
  tokens: count,
  cost_krw: count,
  average_latency_ms: count,
  error_requests: count,
  error_rate: ratio,
  sessions: count,
  work_seconds: count,
  average_session_seconds: count,
  top_models: list({ model: text, requests: count, tokens: count, cost_krw: count }),
  top_languages: list({ language: text, requests: count }),
  daily: list({ day: text, requests: count, tokens: count, cost_krw: count }),
});

export const benchmarkUsersSchema = looseObject({
  users: list({
    api_key_id: text,
    name: text,
    team: text,
    requests: count,
    sessions: count,
    active_days: count,
    commits: count,
    merged_mrs: count,
    tool_calls: count,
    success_rate: ratio,
    cost_krw: count,
    score: count,
  }),
});

/* ------------------------------------------------------------------ teams */

export const teamSummarySchema = looseObject({
  team: z.string(),
  keys: count,
  requests: count,
  tokens: count,
  cost_krw: count,
  average_latency_ms: count,
  last_seen: text,
});
export type TeamSummary = z.output<typeof teamSummarySchema>;

export const authTeamSchema = looseObject({
  id: z.string(),
  name: text,
  created_at: text,
  updated_at: text,
});
export type AuthTeamRow = z.output<typeof authTeamSchema>;

export const adminTeamsSchema = looseObject({
  teams: orDefault(z.array(teamSummarySchema), []),
  auth_teams: orDefault(z.array(authTeamSchema), []),
});

export const teamAdministrationSchema = adminTeamsSchema.extend({
  auth_teams: z
    .array(
      z.object({
        // Existing server IDs are opaque TEXT, not the new-team form's input policy.
        id: z.string().min(1),
        name: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
      }),
    )
    .refine((teams) => new Set(teams.map((team) => team.id)).size === teams.length),
});

export const adminTeamMutationSchema = looseObject({ team: authTeamSchema.nullish() });

export const adminTeamDetailSchema = looseObject({
  stats: unknownRecord.nullish(),
  advanced: unknownRecord.nullish(),
  by_status: list({ status: text, requests: count }),
  daily: list({ day: text, requests: count, tokens: count, cost_krw: count }),
  by_model: list({ model: text, requests: count, tokens: count, cost_krw: count }),
  by_language: list({ language: text, requests: count }),
  by_ip: list({ ip: text, requests: count }),
  by_key: list({ api_key_id: text, name: text, requests: count, cost_krw: count }),
  recent: list({ id: text, model: text, status_code: count, cost_krw: count, created_at: text }),
});
export type AdminTeamDetail = z.output<typeof adminTeamDetailSchema>;

export const teamScorecardSchema = looseObject({
  window: text,
  generated_at: text,
  note: text,
  teams: list({
    team: text,
    requests: count,
    cost_krw: count,
    cost_efficiency: ratio,
    success_rate: ratio,
    cache_rate: ratio,
    skill_reuse: ratio,
    mcp_success: ratio,
    text2sql_success: ratio,
    policy_compliance: ratio,
    satisfaction: ratio,
    overall: ratio,
    grade: text,
  }),
});

export const benchmarkTeamsSchema = looseObject({
  teams: list({
    team: text,
    active_users: count,
    requests: count,
    tokens: count,
    cost_krw: count,
    success_rate: ratio,
    commits: count,
    merged_mrs: count,
    score: count,
  }),
});

/* -------------------------------------------------------------------- ips */

export const adminIpsSchema = looseObject({
  ips: list({
    ip: z.string(),
    requests: count,
    tokens: count,
    cost_krw: count,
    average_latency_ms: count,
    last_seen: text,
    distinct_keys: count,
  }),
});
export type IpSummary = z.output<typeof adminIpsSchema>["ips"][number];

export const adminIpDetailSchema = looseObject({
  stats: unknownRecord.nullish(),
  daily: list({ day: text, requests: count, tokens: count, cost_krw: count }),
  by_model: list({ model: text, requests: count, tokens: count, cost_krw: count }),
  by_language: list({ language: text, requests: count }),
  by_key: list({ api_key_id: text, name: text, requests: count, cost_krw: count }),
  recent: list({ id: text, model: text, status_code: count, cost_krw: count, created_at: text }),
});

/* ---------------------------------------------------------- quotas/budgets */

export const quotaPublicSchema = looseObject({
  id: z.string(),
  scope: text,
  scope_value: text,
  period: text,
  token_limit: count,
  krw_limit: count,
  enabled: orDefault(z.boolean(), false),
  note: text,
  created_at: text,
});
export type QuotaPublic = z.output<typeof quotaPublicSchema>;

export const quotaUsageSchema = looseObject({
  quota: quotaPublicSchema,
  tokens: count,
  cost_krw: count,
  requests: count,
  reserved_tokens: count,
  reserved_cost_krw: count,
  period_start: text,
  period_end: text,
  token_remain_ratio: ratio,
  krw_remain_ratio: ratio,
});
export type QuotaUsage = z.output<typeof quotaUsageSchema>;

export const adminQuotasSchema = looseObject({
  quotas: orDefault(z.array(quotaPublicSchema), []),
  usage: orDefault(z.array(quotaUsageSchema), []),
});

// POST and PATCH /admin/quotas return the Go struct without json tags, so the
// fields keep their exported Go names. This is deliberate, not a typo.
export const quotaSavedSchema = looseObject({
  quota: looseObject({
    ID: text,
    Scope: text,
    ScopeValue: text,
    Period: text,
    TokenLimit: count,
    KRWLimit: count,
    Enabled: orDefault(z.boolean(), false),
    Note: text,
    CreatedAt: text,
  }).nullish(),
});

export const deletionSchema = looseObject({ id: text, status: text });

export const budgetStatusSchema = looseObject({
  budget: looseObject({
    id: z.string(),
    scope: text,
    scope_value: text,
    monthly_krw: count,
    note: text,
    created_at: text,
  }),
  spent_krw: count,
  burn_ratio: ratio,
  projected_krw: count,
  projected_ratio: ratio,
  days_elapsed: count,
  days_in_month: count,
  exhaustion_date: text,
  on_track: orDefault(z.boolean(), true),
});
export type BudgetStatus = z.output<typeof budgetStatusSchema>;

export const adminBudgetsSchema = looseObject({
  budgets: orDefault(z.array(budgetStatusSchema), []),
});

export const budgetCreatedSchema = looseObject({ budget: unknownRecord.nullish() });

export const budgetAlertsSchema = looseObject({
  alerts: list({
    scope: text,
    scope_value: text,
    monthly_krw: count,
    spent_krw: count,
    burn_ratio: ratio,
    projected_ratio: ratio,
    projected_krw: count,
    exhaustion_date: text,
    severity: text,
  }),
  warn: count,
  critical: count,
  thresholds: looseObject({ warn: count, critical: count }).nullish(),
});

export const budgetProjectionSchema = looseObject({
  exceeding: count,
  teams: list({
    team: text,
    spent_krw: count,
    projected_krw: count,
    budget_krw: count,
    has_budget: orDefault(z.boolean(), false),
    will_exceed: orDefault(z.boolean(), false),
    projected_overage_krw: count,
    days_elapsed: count,
    days_in_month: count,
  }),
});
export type BudgetProjectionRow = z.output<typeof budgetProjectionSchema>["teams"][number];

/* --------------------------------------------------------------- api keys */

export const apiKeyPublicSchema = looseObject({
  id: z.string(),
  revision: text,
  replaced_by: text,
  grace_ends_at: text,
  name: text,
  owner: text,
  team: text,
  user_id: text,
  service_account_id: text,
  role: text,
  status: text,
  scopes: stringList,
  allowed_ips: stringList,
  allowed_models: stringList,
  denied_models: stringList,
  allowed_providers: stringList,
  denied_providers: stringList,
  budget_limit_krw: count,
  expires_at: text,
  revoked_at: text,
  created_at: text,
});
export type ApiKeyPublic = z.output<typeof apiKeyPublicSchema>;

export const adminApiKeysSchema = looseObject({
  api_keys: orDefault(z.array(apiKeyPublicSchema), []),
  edit_review_supported: z.boolean().optional().default(false),
  revoke_review_supported: z.boolean().optional().default(false),
});

export const apiKeyCreatedSchema = looseObject({
  api_key: looseObject({
    id: z.string(),
    name: text,
    owner: text,
    team: text,
    user_id: text,
    role: text,
    status: text,
    scopes: stringList,
    allowed_ips: stringList,
  }).nullish(),
  secret: text,
});

// PATCH /me/keys/{id} answers with the stored scopes only, not the whole key.
export const meKeyScopesSchema = looseObject({ id: text, scopes: stringList });

// POST /me/keys/{id}/rotate retires the old id immediately or after grace. The
// rotated key carries no `team` field, unlike the create response.
export const meKeyRotatedSchema = looseObject({
  rotated_from: z.string().min(1),
  grace_ends_at: z.iso.datetime({ offset: true }),
  api_key: looseObject({
    id: z.string().min(1),
    name: z.string(),
    user_id: z.string(),
    role: z.string(),
    scopes: z.array(z.string()),
    status: z.string(),
  }),
  secret: z.string().min(1),
});

export const apiKeyUpdatedSchema = looseObject({
  id: text,
  name: text,
  owner: text,
  team: text,
  role: text,
  status: text,
  scopes: stringList,
});

/* ------------------------------------------------------------------ roles */

export const roleSchema = looseObject({
  role: z.string(),
  scopes: stringList,
  default_home: text,
  is_admin: orDefault(z.boolean(), false),
  is_system: orDefault(z.boolean(), false),
  rank: count,
  description: text,
});
export type RoleRow = z.output<typeof roleSchema>;

export const adminRolesSchema = looseObject({
  roles: orDefault(z.array(roleSchema), []),
  all_scopes: stringList,
});

const matrixIdentifier = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.trim() === value && ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  );
// Missing scopes are not evidence of no grants. Keep the legacy adapter above.
export const roleMatrixSchema = z.object({
  roles: z
    .array(z.object({ role: matrixIdentifier, scopes: z.array(matrixIdentifier).nullable() }))
    .refine((roles) => new Set(roles.map((row) => row.role)).size === roles.length),
  all_scopes: z.array(matrixIdentifier),
});

export const roleAdminSchema = z.object({
  roles: z
    .array(
      roleSchema.extend({
        role: matrixIdentifier,
        scopes: z
          .array(matrixIdentifier)
          .nullable()
          .transform((scopes) => scopes ?? []),
        description: z.string(),
        default_home: z.string(),
        is_system: z.boolean(),
      }),
    )
    .min(1)
    .refine((roles) => new Set(roles.map((row) => row.role)).size === roles.length),
  all_scopes: z.array(matrixIdentifier).min(1),
});

export const roleSavedSchema = looseObject({ role: roleSchema.nullish() });

export const roleDeletedSchema = looseObject({ role: text, deleted: orDefault(z.boolean(), false) });

export const effectivePermissionsSchema = looseObject({
  role: text,
  scopes: stringList,
  default_home: text,
  is_admin: orDefault(z.boolean(), false),
  menu_version: text,
  features: unknownRecord.nullish(),
  menus: list({
    id: text,
    label: text,
    path: text,
    tab: text,
    group: text,
    data_scope: text,
    allowed: orDefault(z.boolean(), false),
    reason: text,
  }),
});

/* -------------------------------------------------------------------- /me */

export {
  meDashboardSchema,
  meActionsSchema,
  meSnoozeSchema,
  meReportSchema,
  meNotificationsSchema,
  meRecommendedModelsSchema,
  meRequestsSchema,
  meReceiptSchema,
  meSkillsSchema,
  meSkillActionSchema,
  meRecommendationsSchema,
  meRecommendationFeedbackSchema,
} from "./me-console.schemas";
export type { MeDashboard, MeAction, MeRequest, MeSkill, MeRecommendation } from "./me-console.schemas";

export {
  meSessionsSchema,
  meSessionRevokedSchema,
  meSessionsRevokedSchema,
  meConnectionDoctorSchema,
  meOnboardingPackSchema,
  type MeSession,
} from "./me-access.schemas";

export const meKeysSchema = looseObject({
  api_keys: orDefault(z.array(apiKeyPublicSchema), []),
  role: text,
  // Unlike an explicitly empty grant list, missing/null is not confirmed authority.
  grantable_scopes: z.array(z.string()).nullish(),
});

export const meKeyCreatedSchema = looseObject({
  api_key: looseObject({
    id: z.string(),
    name: text,
    user_id: text,
    team: text,
    role: text,
    scopes: stringList,
    status: text,
  }).nullish(),
  secret: text,
});

/* ------------------------------------------------------------------ /team */
export {
  teamDashboardSchema,
  teamReportsSchema,
  teamReportDecisionSchema,
  teamSavingsChallengeSchema,
  teamOnboardingSchema,
  teamRiskSchema,
  teamPopularSkillsSchema,
  teamTemplateCandidatesSchema,
  teamPortalSchema,
  type TeamReportRow,
} from "./team.schemas";
