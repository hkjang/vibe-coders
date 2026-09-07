import { z } from "zod";

import {
  adminApiKeysSchema,
  adminBudgetsSchema,
  adminIpDetailSchema,
  adminIpsSchema,
  adminQuotasSchema,
  adminRolesSchema,
  adminTeamDetailSchema,
  adminTeamMutationSchema,
  adminTeamsSchema,
  adminUserDetailSchema,
  adminUserMutationSchema,
  adminUsersSchema,
  apiKeyCreatedSchema,
  apiKeyUpdatedSchema,
  benchmarkTeamsSchema,
  benchmarkUsersSchema,
  budgetAlertsSchema,
  budgetCreatedSchema,
  deletionSchema,
  effectivePermissionsSchema,
  meActionsSchema,
  meConnectionDoctorSchema,
  meDashboardSchema,
  meKeyCreatedSchema,
  meKeysSchema,
  meNotificationsSchema,
  meOnboardingPackSchema,
  meReceiptSchema,
  meRecommendationFeedbackSchema,
  meRecommendationsSchema,
  meRecommendedModelsSchema,
  meReportSchema,
  meRequestsSchema,
  meSessionRevokedSchema,
  meSessionsRevokedSchema,
  meSessionsSchema,
  meSkillsSchema,
  meSnoozeSchema,
  quotaCreatedSchema,
  roleSavedSchema,
  teamDashboardSchema,
  teamOnboardingSchema,
  teamPopularSkillsSchema,
  teamPortalSchema,
  teamReportsSchema,
  teamRiskSchema,
  teamSavingsChallengeSchema,
  teamScorecardSchema,
  teamTemplateCandidatesSchema,
} from "@/shared/api/domains/access.schemas";
import {
  operation,
  pathWithParams,
  type ApiEndpointBase,
  type OperationData,
  type WithQuery,
} from "@/shared/api/endpoint-factory";
import type {
  DeleteAdminApiKeysIdData,
  DeleteAdminBudgetsIdData,
  DeleteAdminQuotasIdData,
  DeleteMeKeysIdData,
  DeleteMeSessionsIdData,
  GetAdminApiKeysData,
  GetAdminBenchmarkTeamsData,
  GetAdminBenchmarkUsersData,
  GetAdminBudgetsAlertsData,
  GetAdminBudgetsData,
  GetAdminIpsData,
  GetAdminIpsIpData,
  GetAdminQuotasData,
  GetAdminRolesData,
  GetAdminTeamsData,
  GetAdminTeamsScorecardData,
  GetAdminTeamsTeamData,
  GetAdminUsersData,
  GetAdminUsersIdData,
  GetMeActionsData,
  GetMeDashboardData,
  GetMeKeysData,
  GetMeNotificationsData,
  GetMeOnboardingPackData,
  GetMeRecommendationsData,
  GetMeRecommendedModelsData,
  GetMeReportData,
  GetMeRequestsData,
  GetMeRequestsIdReceiptData,
  GetMeSessionsData,
  GetMeSkillsData,
  GetPermissionsEffectiveData,
  GetTeamDashboardData,
  GetTeamOnboardingData,
  GetTeamPortalData,
  GetTeamReportsData,
  GetTeamRiskData,
  GetTeamSavingsChallengeData,
  GetTeamSkillsPopularData,
  GetTeamTemplatesCandidatesData,
  PatchAdminApiKeysIdData,
  PatchAdminUsersIdData,
  PostAdminApiKeysData,
  PostAdminBudgetsData,
  PostAdminQuotasData,
  PostAdminRolesData,
  PostAdminTeamsData,
  PostAdminUsersData,
  PostMeActionsSnoozeData,
  PostMeConnectionDoctorData,
  PostMeKeysData,
  PostMeRecommendationsIdFeedbackData,
  PostMeSessionsRevokeOthersData,
} from "@/shared/api/generated";

/**
 * Replaces the generated (usually `never`) request body with the shape the legacy
 * handler actually reads. The OpenAPI document has no request schemas for these
 * operations, so the Go handler's decoded struct is the contract.
 */
type WithBody<Data extends OperationData, Body> = Omit<Data, "body"> & { readonly body: Body };

/** Substitutes `{id}`-style path parameters just before the call. */
export function withPathParams<Endpoint extends ApiEndpointBase>(
  endpoint: Endpoint,
  params: Readonly<Record<string, string | number>>,
): Endpoint {
  return { ...endpoint, path: pathWithParams(endpoint.path, params) } as Endpoint;
}

/* ---------------------------------------------------------------- queries */

const limitQuery = z.object({ limit: z.number().int().positive().max(500).optional() });
const windowQuery = z.object({ window: z.string().optional() });
const windowLimitQuery = z.object({
  window: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
const budgetAlertsQuery = z.object({
  warn: z.number().optional(),
  critical: z.number().optional(),
  all: z.number().int().optional(),
  notify: z.number().int().optional(),
});
const hardDeleteQuery = z.object({ hard: z.number().int().optional() });
const meReportQuery = z.object({ window: z.enum(["weekly", "monthly"]).optional() });
const meRequestsQuery = z.object({ limit: z.number().int().positive().max(100).optional() });
const onboardingPackQuery = z.object({ client: z.string().optional() });
const effectivePermissionsQuery = z.object({ role: z.string().optional() });
const teamWindowQuery = z.object({ window: z.string().optional(), team: z.string().optional() });
const teamCandidatesQuery = z.object({
  window: z.string().optional(),
  team: z.string().optional(),
  min_count: z.number().int().positive().optional(),
});

export type LimitQuery = z.infer<typeof limitQuery>;
export type WindowQuery = z.infer<typeof windowQuery>;
export type WindowLimitQuery = z.infer<typeof windowLimitQuery>;
export type BudgetAlertsQuery = z.infer<typeof budgetAlertsQuery>;
export type HardDeleteQuery = z.infer<typeof hardDeleteQuery>;
export type MeReportQuery = z.infer<typeof meReportQuery>;
export type MeRequestsQuery = z.infer<typeof meRequestsQuery>;
export type OnboardingPackQuery = z.infer<typeof onboardingPackQuery>;
export type EffectivePermissionsQuery = z.infer<typeof effectivePermissionsQuery>;
export type TeamWindowQuery = z.infer<typeof teamWindowQuery>;
export type TeamCandidatesQuery = z.infer<typeof teamCandidatesQuery>;

/* ------------------------------------------------------------------ bodies */

export interface CreateUserBody {
  email: string;
  password: string;
  name?: string;
  role?: string;
  team_id?: string;
}
/** `PATCH /admin/users/{id}` only accepts these three fields, and only for `usr_` ids. */
export interface UpdateUserBody {
  role?: string;
  status?: "active" | "disabled";
  team_id?: string;
}
export interface CreateTeamBody {
  id?: string;
  name: string;
}
export interface CreateQuotaBody {
  scope: "api_key" | "team" | "ip" | "global";
  scope_value: string;
  period: "daily" | "monthly";
  token_limit?: number;
  krw_limit?: number;
  enabled?: boolean;
  note?: string;
}
export interface CreateBudgetBody {
  scope: "global" | "team" | "api_key";
  scope_value: string;
  monthly_krw: number;
  note?: string;
}
export interface CreateApiKeyBody {
  name: string;
  owner?: string;
  team?: string;
  user_id?: string;
  role?: string;
  scopes?: readonly string[];
  allowed_ips?: readonly string[];
  allowed_models?: readonly string[];
  denied_models?: readonly string[];
  budget_limit_krw?: number;
  expires_at?: string;
}
export interface UpdateApiKeyBody {
  status?: "active" | "disabled";
  name?: string;
  owner?: string;
  team?: string;
  role?: string;
  scopes?: readonly string[];
}
export interface SaveRoleBody {
  role: string;
  description?: string;
  scopes?: readonly string[];
  default_home?: string;
}
export interface SnoozeActionBody {
  type: string;
  days?: number;
}
export interface ConnectionDoctorBody {
  client: string;
}
/** The server reads `action`, not `decision`. */
export interface RecommendationFeedbackBody {
  action: "adopted" | "dismissed" | "later";
  reason?: string;
}
export interface CreateMeKeyBody {
  name: string;
  scopes?: readonly string[];
  expires_at?: string;
}

/* -------------------------------------------------------------- endpoints */

export const accessEndpoints = {
  users: {
    list: operation<GetAdminUsersData, unknown>()("GET", "/admin/users", adminUsersSchema),
    create: operation<WithBody<PostAdminUsersData, CreateUserBody>, unknown>()(
      "POST",
      "/admin/users",
      adminUserMutationSchema,
    ),
    update: operation<WithBody<PatchAdminUsersIdData, UpdateUserBody>, unknown>()(
      "PATCH",
      "/admin/users/{id}",
      adminUserMutationSchema,
    ),
    detail: operation<WithQuery<GetAdminUsersIdData, LimitQuery>, unknown>()(
      "GET",
      "/admin/users/{id}",
      adminUserDetailSchema,
      limitQuery,
    ),
    benchmark: operation<WithQuery<GetAdminBenchmarkUsersData, WindowLimitQuery>, unknown>()(
      "GET",
      "/admin/benchmark/users",
      benchmarkUsersSchema,
      windowLimitQuery,
    ),
  },
  teams: {
    list: operation<GetAdminTeamsData, unknown>()("GET", "/admin/teams", adminTeamsSchema),
    create: operation<WithBody<PostAdminTeamsData, CreateTeamBody>, unknown>()(
      "POST",
      "/admin/teams",
      adminTeamMutationSchema,
    ),
    detail: operation<WithQuery<GetAdminTeamsTeamData, LimitQuery>, unknown>()(
      "GET",
      "/admin/teams/{team}",
      adminTeamDetailSchema,
      limitQuery,
    ),
    scorecard: operation<WithQuery<GetAdminTeamsScorecardData, WindowQuery>, unknown>()(
      "GET",
      "/admin/teams/scorecard",
      teamScorecardSchema,
      windowQuery,
    ),
    benchmark: operation<WithQuery<GetAdminBenchmarkTeamsData, WindowQuery>, unknown>()(
      "GET",
      "/admin/benchmark/teams",
      benchmarkTeamsSchema,
      windowQuery,
    ),
  },
  ips: {
    list: operation<GetAdminIpsData, unknown>()("GET", "/admin/ips", adminIpsSchema),
    detail: operation<WithQuery<GetAdminIpsIpData, LimitQuery>, unknown>()(
      "GET",
      "/admin/ips/{ip}",
      adminIpDetailSchema,
      limitQuery,
    ),
  },
  quotas: {
    list: operation<GetAdminQuotasData, unknown>()("GET", "/admin/quotas", adminQuotasSchema),
    create: operation<WithBody<PostAdminQuotasData, CreateQuotaBody>, unknown>()(
      "POST",
      "/admin/quotas",
      quotaCreatedSchema,
    ),
    remove: operation<DeleteAdminQuotasIdData, unknown>()("DELETE", "/admin/quotas/{id}", deletionSchema),
  },
  budgets: {
    list: operation<GetAdminBudgetsData, unknown>()("GET", "/admin/budgets", adminBudgetsSchema),
    create: operation<WithBody<PostAdminBudgetsData, CreateBudgetBody>, unknown>()(
      "POST",
      "/admin/budgets",
      budgetCreatedSchema,
    ),
    remove: operation<DeleteAdminBudgetsIdData, unknown>()("DELETE", "/admin/budgets/{id}", deletionSchema),
    alerts: operation<WithQuery<GetAdminBudgetsAlertsData, BudgetAlertsQuery>, unknown>()(
      "GET",
      "/admin/budgets/alerts",
      budgetAlertsSchema,
      budgetAlertsQuery,
    ),
  },
  apiKeys: {
    list: operation<GetAdminApiKeysData, unknown>()("GET", "/admin/api-keys", adminApiKeysSchema),
    create: operation<WithBody<PostAdminApiKeysData, CreateApiKeyBody>, unknown>()(
      "POST",
      "/admin/api-keys",
      apiKeyCreatedSchema,
    ),
    update: operation<WithBody<PatchAdminApiKeysIdData, UpdateApiKeyBody>, unknown>()(
      "PATCH",
      "/admin/api-keys/{id}",
      apiKeyUpdatedSchema,
    ),
    revoke: operation<WithQuery<DeleteAdminApiKeysIdData, HardDeleteQuery>, unknown>()(
      "DELETE",
      "/admin/api-keys/{id}",
      deletionSchema,
      hardDeleteQuery,
    ),
  },
  roles: {
    list: operation<GetAdminRolesData, unknown>()("GET", "/admin/roles", adminRolesSchema),
    save: operation<WithBody<PostAdminRolesData, SaveRoleBody>, unknown>()(
      "POST",
      "/admin/roles",
      roleSavedSchema,
    ),
  },
  permissions: {
    effective: operation<WithQuery<GetPermissionsEffectiveData, EffectivePermissionsQuery>, unknown>()(
      "GET",
      "/permissions/effective",
      effectivePermissionsSchema,
      effectivePermissionsQuery,
    ),
  },
  me: {
    dashboard: operation<GetMeDashboardData, unknown>()("GET", "/me/dashboard", meDashboardSchema),
    actions: operation<GetMeActionsData, unknown>()("GET", "/me/actions", meActionsSchema),
    snooze: operation<WithBody<PostMeActionsSnoozeData, SnoozeActionBody>, unknown>()(
      "POST",
      "/me/actions/snooze",
      meSnoozeSchema,
    ),
    report: operation<WithQuery<GetMeReportData, MeReportQuery>, unknown>()(
      "GET",
      "/me/report",
      meReportSchema,
      meReportQuery,
    ),
    notifications: operation<GetMeNotificationsData, unknown>()(
      "GET",
      "/me/notifications",
      meNotificationsSchema,
    ),
    recommendedModels: operation<GetMeRecommendedModelsData, unknown>()(
      "GET",
      "/me/recommended-models",
      meRecommendedModelsSchema,
    ),
    requests: operation<WithQuery<GetMeRequestsData, MeRequestsQuery>, unknown>()(
      "GET",
      "/me/requests",
      meRequestsSchema,
      meRequestsQuery,
    ),
    receipt: operation<GetMeRequestsIdReceiptData, unknown>()(
      "GET",
      "/me/requests/{id}/receipt",
      meReceiptSchema,
    ),
    skills: operation<GetMeSkillsData, unknown>()("GET", "/me/skills", meSkillsSchema),
    sessions: operation<GetMeSessionsData, unknown>()("GET", "/me/sessions", meSessionsSchema),
    revokeSession: operation<DeleteMeSessionsIdData, unknown>()(
      "DELETE",
      "/me/sessions/{id}",
      meSessionRevokedSchema,
    ),
    revokeOtherSessions: operation<PostMeSessionsRevokeOthersData, unknown>()(
      "POST",
      "/me/sessions/revoke-others",
      meSessionsRevokedSchema,
    ),
    connectionDoctor: operation<WithBody<PostMeConnectionDoctorData, ConnectionDoctorBody>, unknown>()(
      "POST",
      "/me/connection-doctor",
      meConnectionDoctorSchema,
    ),
    recommendations: operation<GetMeRecommendationsData, unknown>()(
      "GET",
      "/me/recommendations",
      meRecommendationsSchema,
    ),
    recommendationFeedback: operation<
      WithBody<PostMeRecommendationsIdFeedbackData, RecommendationFeedbackBody>,
      unknown
    >()("POST", "/me/recommendations/{id}/feedback", meRecommendationFeedbackSchema),
    keys: operation<GetMeKeysData, unknown>()("GET", "/me/keys", meKeysSchema),
    createKey: operation<WithBody<PostMeKeysData, CreateMeKeyBody>, unknown>()(
      "POST",
      "/me/keys",
      meKeyCreatedSchema,
    ),
    revokeKey: operation<DeleteMeKeysIdData, unknown>()("DELETE", "/me/keys/{id}", deletionSchema),
    onboardingPack: operation<WithQuery<GetMeOnboardingPackData, OnboardingPackQuery>, unknown>()(
      "GET",
      "/me/onboarding-pack",
      meOnboardingPackSchema,
      onboardingPackQuery,
    ),
  },
  team: {
    dashboard: operation<WithQuery<GetTeamDashboardData, TeamWindowQuery>, unknown>()(
      "GET",
      "/team/dashboard",
      teamDashboardSchema,
      teamWindowQuery,
    ),
    reports: operation<WithQuery<GetTeamReportsData, TeamWindowQuery>, unknown>()(
      "GET",
      "/team/reports",
      teamReportsSchema,
      teamWindowQuery,
    ),
    savingsChallenge: operation<WithQuery<GetTeamSavingsChallengeData, TeamWindowQuery>, unknown>()(
      "GET",
      "/team/savings-challenge",
      teamSavingsChallengeSchema,
      teamWindowQuery,
    ),
    onboarding: operation<WithQuery<GetTeamOnboardingData, TeamWindowQuery>, unknown>()(
      "GET",
      "/team/onboarding",
      teamOnboardingSchema,
      teamWindowQuery,
    ),
    risk: operation<WithQuery<GetTeamRiskData, TeamWindowQuery>, unknown>()(
      "GET",
      "/team/risk",
      teamRiskSchema,
      teamWindowQuery,
    ),
    popularSkills: operation<WithQuery<GetTeamSkillsPopularData, TeamWindowQuery>, unknown>()(
      "GET",
      "/team/skills/popular",
      teamPopularSkillsSchema,
      teamWindowQuery,
    ),
    templateCandidates: operation<WithQuery<GetTeamTemplatesCandidatesData, TeamCandidatesQuery>, unknown>()(
      "GET",
      "/team/templates/candidates",
      teamTemplateCandidatesSchema,
      teamCandidatesQuery,
    ),
    portal: operation<WithQuery<GetTeamPortalData, TeamWindowQuery>, unknown>()(
      "GET",
      "/team/portal",
      teamPortalSchema,
      teamWindowQuery,
    ),
  },
} as const;
