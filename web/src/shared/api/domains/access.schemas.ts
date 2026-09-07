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

// POST /admin/quotas returns the Go struct without json tags, so the fields keep
// their exported Go names. This is deliberate, not a typo.
export const quotaCreatedSchema = looseObject({
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

/* --------------------------------------------------------------- api keys */

export const apiKeyPublicSchema = looseObject({
  id: z.string(),
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

export const roleSavedSchema = looseObject({ role: roleSchema.nullish() });

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

export const meDashboardSchema = looseObject({
  user_id: text,
  today: looseObject({ requests: count, tokens: count, cost_krw: count, errors: count }).nullish(),
  month: looseObject({ requests: count, tokens: count, cost_krw: count, errors: count }).nullish(),
  profile: looseObject({
    success_rate: ratio,
    avg_latency_ms: count,
    cache_rate: ratio,
    text2sql_usage_rate: ratio,
    mcp_usage_rate: ratio,
    risk_score: count,
    summary: text,
    since: text,
    top_task_types: list({ key: text, requests: count }),
    top_models: list({ model: text, key: text, requests: count }),
    top_languages: list({ language: text, key: text, requests: count }),
    top_mcp_tools: list({ tool: text, key: text, requests: count }),
  }).nullish(),
  frequent_models: list({ model: text, requests: count, avg_cost_krw: count, success_rate: ratio }),
  recent_failures: list({
    id: text,
    model: text,
    status_code: count,
    error: text,
    task_type: text,
    created_at: text,
  }),
  potential_savings_krw: count,
  potential_savings_model: text,
  recommended_templates: orDefault(z.array(unknownRecord), []),
  recent_prompt_products: orDefault(z.array(unknownRecord), []),
  // The legacy screen showed `key_alerts[].reason`, which the server never sends.
  // `flags` and `severity` are the real signals.
  key_alerts: list({
    id: text,
    name: text,
    user_id: text,
    team: text,
    expires_at: text,
    last_used_at: text,
    days_idle: count,
    flags: stringList,
    severity: text,
  }),
  recent_blocks: list({ rule: text, reason: text, model: text, endpoint: text, created_at: text }),
  my_saved_reports: list({
    id: text,
    name: text,
    schema_name: text,
    kind: text,
    visibility: text,
    approval_status: text,
    created_at: text,
  }),
});
export type MeDashboard = z.output<typeof meDashboardSchema>;

export const meActionsSchema = looseObject({
  user_id: text,
  count: count,
  actions: list({
    type: text,
    severity: text,
    message: text,
    button_label: text,
    button_href: text,
  }),
});
export type MeAction = z.output<typeof meActionsSchema>["actions"][number];

export const meSnoozeSchema = looseObject({ type: text, snoozed_until: text });

export const meReportSchema = looseObject({
  user_id: text,
  window: text,
  since: text,
  requests: count,
  tokens: count,
  cost_krw: count,
  errors: count,
  success_rate: ratio,
  prior_cost_krw: count,
  prior_requests: count,
  cost_delta_ratio: ratio,
  avg_latency_ms: count,
  cache_rate: ratio,
  risk_score: count,
  top_models: orDefault(z.array(unknownRecord), []),
  top_task_types: orDefault(z.array(unknownRecord), []),
  potential_savings_krw: count,
  potential_savings_model: text,
  recommendation_count: count,
});

export const meNotificationsSchema = looseObject({
  user_id: text,
  count: count,
  critical_count: count,
  notifications: list({
    category: text,
    level: text,
    title: text,
    detail: text,
    created_at: text,
    href: text,
  }),
});

export const meRecommendedModelsSchema = looseObject({
  note: text,
  tagged_model_count: count,
  task_recommendations: list({
    task_type: text,
    requests: count,
    recommend: stringList,
    avoid: stringList,
  }),
  your_models: list({
    model: text,
    requests: count,
    tags: looseObject({ good_for: text, avoid_for: text, risk_note: text }).nullish(),
  }),
  team_winners: list({ model: text, wins: count, avg_score: count, appearances: count }),
});

export const meRequestsSchema = looseObject({
  requests: list({
    id: z.string(),
    model: text,
    provider: text,
    endpoint: text,
    status_code: count,
    cost_krw: count,
    total_tokens: count,
    cached: orDefault(z.boolean(), false),
    created_at: text,
  }),
});
export type MeRequest = z.output<typeof meRequestsSchema>["requests"][number];

export const meReceiptSchema = looseObject({
  request_id: text,
  created_at: text,
  endpoint: text,
  model: text,
  provider: text,
  status_code: count,
  finish_reason: text,
  latency_ms: count,
  tokens: looseObject({ prompt: count, completion: count, total: count, cached: count }).nullish(),
  cache_hit: orDefault(z.boolean(), false),
  cost_krw: count,
  blocked: orDefault(z.boolean(), false),
  policy: list({ decision: text, rule: text, reason: text }),
  mcp_used: orDefault(z.boolean(), false),
  mcp_tools: list({ server: text, tool: text, error: text }),
  skill_used: orDefault(z.boolean(), false),
  skills: stringList,
  note: text,
  routing: looseObject({
    requested_model: text,
    selected_model: text,
    selected_provider: text,
    reason: text,
    fallback_path: stringList,
    risk_tier: text,
    complexity_tier: text,
  }).nullish(),
});

const meSkillSchema = {
  name: z.string(),
  description: text,
  risk_level: text,
  runs_30d: count,
  success_rate: ratio,
  users_30d: count,
  satisfaction: ratio,
  feedback_count: count,
};

export const meSkillsSchema = looseObject({
  team: text,
  available: list(meSkillSchema),
  requestable: list(meSkillSchema),
});

export const meSessionsSchema = looseObject({
  current_session_id: text,
  sessions: list({
    id: z.string(),
    ip: text,
    user_agent: text,
    created_at: text,
    expires_at: text,
    sso_linked: orDefault(z.boolean(), false),
    current: orDefault(z.boolean(), false),
  }),
});
export type MeSession = z.output<typeof meSessionsSchema>["sessions"][number];

export const meSessionRevokedSchema = looseObject({ status: text, session_id: text });
export const meSessionsRevokedSchema = looseObject({ status: text, revoked_count: count });

export const meConnectionDoctorSchema = looseObject({
  client: text,
  overall: text,
  base_url: text,
  mcp_url: text,
  auth_mode: text,
  note: text,
  checks: list({ name: text, status: text, detail: text, fix: text }),
});

export const meRecommendationsSchema = looseObject({
  user_id: text,
  recommendations: list({
    id: z.string(),
    user_id: text,
    kind: text,
    ref: text,
    title: text,
    detail: text,
    est_savings_krw: count,
    created_at: text,
  }),
});
export type MeRecommendation = z.output<typeof meRecommendationsSchema>["recommendations"][number];

export const meRecommendationFeedbackSchema = looseObject({
  id: text,
  action: text,
  status: text,
});

export const meKeysSchema = looseObject({
  api_keys: orDefault(z.array(apiKeyPublicSchema), []),
  role: text,
  grantable_scopes: stringList,
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

export const meOnboardingPackSchema = looseObject({
  client: text,
  base_url: text,
  mcp_url: text,
  available_models: stringList,
  recommended_models: stringList,
  scopes: stringList,
  budget_limit_krw: count,
  mcp_config: z.unknown(),
  sample_curl: text,
  note: text,
  config_label: text,
  config: z.unknown(),
});

/* ------------------------------------------------------------------ /team */

export const teamDashboardSchema = looseObject({
  team_id: text,
  since: text,
  dashboard: looseObject({
    team_keys: stringList,
    totals: looseObject({
      requests: count,
      tokens: count,
      cost_krw: count,
      errors: count,
      avg_latency_ms: count,
      success_rate: ratio,
    }).nullish(),
    top_users: list({ user_id: text, requests: count, cost_krw: count, errors: count }),
    models: list({ model: text, requests: count, cost_krw: count }),
    recent_failures: list({
      id: text,
      model: text,
      status_code: count,
      error: text,
      created_at: text,
    }),
  }).nullish(),
});

export const teamReportsSchema = looseObject({
  team_id: text,
  reports: list({
    id: z.string(),
    name: text,
    question: text,
    schema_name: text,
    kind: text,
    created_by: text,
    created_at: text,
    schedule_interval: text,
    schedule_enabled: orDefault(z.boolean(), false),
    deliver_mattermost: orDefault(z.boolean(), false),
    last_run_at: text,
    team: text,
    visibility: text,
    approval_status: text,
    approved_by: text,
    approved_at: text,
  }),
});

export const teamSavingsChallengeSchema = looseObject({
  team_id: text,
  month_to_date_krw: count,
  projected_month_end_krw: count,
  last_month_krw: count,
  projected_savings_krw: count,
  on_track: orDefault(z.boolean(), true),
  days_elapsed: count,
  days_in_month: count,
});

export const teamOnboardingSchema = looseObject({
  team_id: text,
  since: text,
  note: text,
  recommended_models: orDefault(z.array(z.unknown()), []),
  recommended_skills: orDefault(z.array(z.unknown()), []),
  recommended_mcp: list({
    server_label: text,
    tool_name: text,
    ref: text,
    calls: count,
    errors: count,
    success_rate: ratio,
    avg_latency_ms: count,
  }),
});

export const teamRiskSchema = looseObject({
  team_id: text,
  since: text,
  blocked: count,
  warned: count,
  blocked_prior_window: count,
  blocked_trend: text,
  secrets_total: count,
  secrets_by_type: orDefault(z.record(z.string(), numberish), {}),
  pending_approvals: count,
  recent_violations: list({
    decision: text,
    reason: text,
    rule: text,
    endpoint: text,
    risk_score: count,
    created_at: text,
  }),
});

export const teamPopularSkillsSchema = looseObject({
  team_id: text,
  since: text,
  skills: list({
    skill_name: text,
    runs: count,
    ok: count,
    errors: count,
    success_rate: ratio,
    total_cost_krw: count,
    avg_latency_ms: count,
  }),
});

export const teamTemplateCandidatesSchema = looseObject({
  team_id: text,
  since: text,
  candidates: list({
    fingerprint: text,
    task_type: text,
    requests: count,
    avg_cost_krw: count,
    success_rate: ratio,
    already_product: orDefault(z.boolean(), false),
  }),
});

export const teamPortalSchema = looseObject({
  team_id: text,
  since: text,
  note: text,
  usage: looseObject({
    requests: count,
    cost_krw: count,
    errors: count,
    success_rate: ratio,
    avg_latency_ms: count,
  }).nullish(),
  budgets: list({
    monthly_krw: count,
    spent_krw: count,
    burn_ratio: ratio,
    projected_krw: count,
    projected_ratio: ratio,
    on_track: orDefault(z.boolean(), true),
    exhaustion_date: text,
    note: text,
  }),
  api_keys: list({
    id: z.string(),
    name: text,
    owner: text,
    user_id: text,
    role: text,
    status: text,
    expires_at: text,
    budget_limit_krw: count,
  }),
  api_key_count: count,
  members: stringList,
  member_count: count,
  accessible_skills: list({ name: text, description: text, version: text, risk_level: text }),
  skill_count: count,
  pending_skill_requests: list({
    id: z.string(),
    skill_name: text,
    user_id: text,
    reason: text,
    created_at: text,
  }),
});
