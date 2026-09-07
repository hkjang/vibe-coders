import { z } from "zod";

import type {
  GetAdminBenchmarkTeamsData,
  GetAdminBenchmarkUsersData,
  GetAdminPersonalizationCoachingData,
  GetAdminPersonalizationMcpAffinityData,
  GetAdminPersonalizationModelAffinityData,
  GetAdminPersonalizationProfilesData,
  GetAdminPersonalizationProfilesUserIdData,
  PostAdminPersonalizationProfilesUserIdData,
  GetAdminPersonalizationText2SqlHintsData,
  GetAdminProductivityData,
  GetAdminRecommendationsAdoptionData,
  GetAdminReportsNarrativeData,
  GetAdminSbomData,
  GetAdminTeamsScorecardData,
} from "@/shared/api/generated";
import { operation, pathWithParams, type WithQuery } from "@/shared/api/endpoint-factory";
import { looseList, looseObject, numberish, orDefault, unknownRecord } from "@/shared/api/loose";

// governance-reports domain endpoints. Declare every server call this domain's screens make
// here with `operation()` from "@/shared/api/endpoint-factory" and a zod schema
// (see "@/shared/api/loose" for legacy responses without a documented shape).
//
// Every response below is documented as `unknown` in the OpenAPI spec, so these zod
// schemas are the contract; field names come from the Go handlers
// (`internal/proxy/admin_team_scorecard.go`, `admin_narrative_report.go`,
// `admin_productivity.go`, `admin_benchmark.go`, `admin_sbom.go`,
// `admin_personalization.go`, `my_home.go`).

const count = (fallback = 0) => orDefault(numberish, fallback);
const text = (fallback = "") => orDefault(z.string(), fallback);

/** `?window=` accepts `1h|6h|24h|1d|7d|30d` or a Go duration; screens send a fixed set. */
const windowQuerySchema = z.object({ window: z.string().optional() });
const windowLimitQuerySchema = z.object({
  window: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
const hintsQuerySchema = z.object({
  window: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  min_count: z.number().int().min(2).max(100).optional(),
});
const productivityQuerySchema = z.object({ days: z.number().int().min(1).max(365).optional() });
const profileQuerySchema = z.object({ window: z.string().optional() });

export type GovernanceWindowQuery = z.infer<typeof windowQuerySchema>;
export type GovernanceWindowLimitQuery = z.infer<typeof windowLimitQuerySchema>;
export type GovernanceHintsQuery = z.infer<typeof hintsQuerySchema>;
export type GovernanceProductivityQuery = z.infer<typeof productivityQuerySchema>;
export type GovernanceProfileQuery = z.infer<typeof profileQuerySchema>;

// --- 팀 성숙도 스코어카드 -------------------------------------------------------------
// Dimension scores are 0..100 and **-1 means "no data"** (excluded from `overall`).
const teamScoreSchema = looseObject({
  team: text(),
  requests: count(),
  cost_krw: count(),
  cost_efficiency: count(-1),
  success_rate: count(-1),
  cache_rate: count(-1),
  skill_reuse: count(-1),
  mcp_success: count(-1),
  text2sql_success: count(-1),
  policy_compliance: count(-1),
  satisfaction: count(-1),
  overall: count(),
  grade: text("N/A"),
});
export type TeamScorecardRow = z.infer<typeof teamScoreSchema>;

const teamScorecardSchema = looseObject({
  window: text(),
  generated_at: text(),
  teams: orDefault(z.array(teamScoreSchema), []),
  note: text(),
});

// --- 운영 보고서 (서술형) -------------------------------------------------------------
const narrativeSectionSchema = looseObject({
  title: text(),
  narrative: text(),
  metrics: unknownRecord.nullish(),
});
export type NarrativeSection = z.infer<typeof narrativeSectionSchema>;

const narrativeReportSchema = looseObject({
  period_start: text(),
  period_end: text(),
  generated_at: text(),
  sections: orDefault(z.array(narrativeSectionSchema), []),
  note: text(),
});

// --- AI 업무성과 (repo별 AI 사용 ↔ 개발 산출) -----------------------------------------
const productivityRepoSchema = looseObject({
  repo: text(),
  ai_requests: count(),
  ai_tokens: count(),
  ai_cost_krw: count(),
  commits: count(),
  merge_requests: count(),
  merged: count(),
  cost_per_merged_krw: count(),
});
export type ProductivityRepoRow = z.infer<typeof productivityRepoSchema>;

const productivitySchema = looseObject({
  days: count(30),
  repos: orDefault(z.array(productivityRepoSchema), []),
  totals: orDefault(looseObject({ ai_requests: count(), merged: count(), ai_cost_krw: count() }), {
    ai_requests: 0,
    merged: 0,
    ai_cost_krw: 0,
  }),
  note: text(),
});

// --- 벤치마크 (AI 활용지수) -----------------------------------------------------------
const benchmarkUserSchema = looseObject({
  api_key_id: text(),
  name: text(),
  team: text(),
  requests: count(),
  sessions: count(),
  active_days: count(),
  commits: count(),
  merged_mrs: count(),
  tool_calls: count(),
  success_rate: count(),
  cost_krw: count(),
  score: count(),
});
export type BenchmarkUserRow = z.infer<typeof benchmarkUserSchema>;

const benchmarkUsersSchema = looseObject({ users: orDefault(z.array(benchmarkUserSchema), []) });

const benchmarkTeamSchema = looseObject({
  team: text(),
  active_users: count(),
  requests: count(),
  tokens: count(),
  cost_krw: count(),
  success_rate: count(),
  commits: count(),
  merged_mrs: count(),
  score: count(),
});
export type BenchmarkTeamRow = z.infer<typeof benchmarkTeamSchema>;

const benchmarkTeamsSchema = looseObject({ teams: orDefault(z.array(benchmarkTeamSchema), []) });

// --- AI 자산 SBOM ---------------------------------------------------------------------
const sbomEntrySchema = looseObject({
  type: text(),
  id: text(),
  name: text(),
  owner: text(),
  status: text(),
  deps: text(),
  gaps: orDefault(z.array(z.string()), []),
});
export type SbomEntry = z.infer<typeof sbomEntrySchema>;

const sbomSchema = looseObject({
  total: count(),
  by_type: orDefault(z.record(z.string(), numberish), {}),
  gap_count: count(),
  entries: orDefault(z.array(sbomEntrySchema), []),
  note: text(),
});

// --- 개인화 ----------------------------------------------------------------------------
const profileCountSchema = looseObject({ key: text(), requests: count() });
export type ProfileCount = z.infer<typeof profileCountSchema>;

const personalProfileSchema = looseObject({
  user_id: text(),
  team: text(),
  role: text(),
  requests: count(),
  total_cost_krw: count(),
  avg_cost_per_request: count(),
  avg_latency_ms: count(),
  success_rate: count(),
  error_rate: count(),
  cache_rate: count(),
  text2sql_usage_rate: count(),
  mcp_usage_rate: count(),
  risk_score: count(),
  distinct_models: count(),
  distinct_prompt_fingerprints: count(),
  top_task_types: orDefault(z.array(profileCountSchema), []),
  top_models: orDefault(z.array(profileCountSchema), []),
  top_languages: orDefault(z.array(profileCountSchema), []),
  top_mcp_tools: orDefault(z.array(profileCountSchema), []),
  summary: text(),
  since: text(),
});
export type PersonalProfile = z.infer<typeof personalProfileSchema>;

const profilesSchema = looseObject({ profiles: orDefault(z.array(personalProfileSchema), []) });

const profileDriftSchema = looseObject({
  user_id: text(),
  has_baseline: orDefault(z.boolean(), false),
  from: text(),
  to: text(),
  requests_delta: count(),
  cost_delta_krw: count(),
  avg_cost_delta_krw: count(),
  success_rate_delta: count(),
  top_model_from: text(),
  top_model_to: text(),
  top_model_changed: orDefault(z.boolean(), false),
  top_task_from: text(),
  top_task_to: text(),
  top_task_changed: orDefault(z.boolean(), false),
  flags: orDefault(z.array(z.string()), []),
});
export type ProfileDrift = z.infer<typeof profileDriftSchema>;

/** `profile` is the stored profile JSON as a string; the screen parses it defensively. */
const profileSnapshotSchema = looseObject({ id: text(), profile: text(), created_at: text() });
export type ProfileSnapshot = z.infer<typeof profileSnapshotSchema>;

const profileDetailSchema = looseObject({
  profile: personalProfileSchema.nullish(),
  snapshots: orDefault(z.array(profileSnapshotSchema), []),
  drift: profileDriftSchema.nullish(),
});

const coachingItemSchema = looseObject({
  user_id: text(),
  team: text(),
  role: text(),
  category: text(),
  severity: text("low"),
  score: count(),
  title: text(),
  detail: text(),
  reason: text(),
});
export type CoachingItem = z.infer<typeof coachingItemSchema>;

const coachingSchema = looseObject({
  items: orDefault(z.array(coachingItemSchema), []),
  count: count(),
});

const modelAffinitySchema = looseObject({
  items: orDefault(
    looseList({
      user_id: text(),
      team: text(),
      model: text(),
      requests: count(),
      avg_cost_krw: count(),
      success_rate: count(),
      score: count(),
      reason: text(),
    }),
    [],
  ),
  count: count(),
});
export type ModelAffinityItem = z.infer<typeof modelAffinitySchema>["items"][number];

const mcpAffinitySchema = looseObject({
  items: orDefault(
    looseList({
      user_id: text(),
      team: text(),
      server_label: text(),
      tool_name: text(),
      ref: text(),
      calls: count(),
      errors: count(),
      success_rate: count(),
      avg_request_latency_ms: count(),
      score: count(),
      reason: text(),
    }),
    [],
  ),
  count: count(),
});
export type McpAffinityItem = z.infer<typeof mcpAffinitySchema>["items"][number];

const text2sqlHintsSchema = looseObject({
  items: orDefault(
    looseList({
      user_id: text(),
      team: text(),
      fingerprint: text(),
      schema_name: text(),
      count: count(),
      success_rate: count(),
      avg_cost_krw: count(),
      estimated_savings_krw: count(),
      last_seen: text(),
      recommended_product: text(),
      hint_type: text(),
      reason: text(),
    }),
    [],
  ),
  count: count(),
});
export type Text2SqlHintItem = z.infer<typeof text2sqlHintsSchema>["items"][number];

const adoptionSchema = looseObject({
  by_kind: orDefault(
    looseList({
      kind: text(),
      adopted: count(),
      dismissed: count(),
      distinct_adopters: count(),
      adoption_rate: count(),
    }),
    [],
  ),
  total_adopted: count(),
  total_dismissed: count(),
  overall_adoption_rate: count(),
});
export type AdoptionRow = z.infer<typeof adoptionSchema>["by_kind"][number];

const personalizationProfileDetail = operation<
  WithQuery<GetAdminPersonalizationProfilesUserIdData, GovernanceProfileQuery>,
  unknown
>()("GET", "/admin/personalization/profiles/{user_id}", profileDetailSchema, profileQuerySchema);

const personalizationProfileSnapshot = operation<
  WithQuery<PostAdminPersonalizationProfilesUserIdData, GovernanceProfileQuery>,
  unknown
>()("POST", "/admin/personalization/profiles/{user_id}", profileDetailSchema, profileQuerySchema);

/**
 * Binds one user id into the profile detail route. The user id is percent-encoded,
 * so it can never introduce a new path segment or query string.
 */
export function personalizationProfileEndpoint(userId: string): typeof personalizationProfileDetail {
  return {
    ...personalizationProfileDetail,
    path: pathWithParams("/admin/personalization/profiles/{user_id}", { user_id: userId }),
  };
}

/** The same route as a POST, which is what records a point-in-time snapshot. */
export function personalizationSnapshotEndpoint(userId: string): typeof personalizationProfileSnapshot {
  return {
    ...personalizationProfileSnapshot,
    path: pathWithParams("/admin/personalization/profiles/{user_id}", { user_id: userId }),
  };
}

export const governanceReportsEndpoints = {
  teamScorecard: operation<WithQuery<GetAdminTeamsScorecardData, GovernanceWindowQuery>, unknown>()(
    "GET",
    "/admin/teams/scorecard",
    teamScorecardSchema,
    windowQuerySchema,
  ),
  narrativeReport: operation<WithQuery<GetAdminReportsNarrativeData, GovernanceWindowQuery>, unknown>()(
    "GET",
    "/admin/reports/narrative",
    narrativeReportSchema,
    windowQuerySchema,
  ),
  productivity: operation<WithQuery<GetAdminProductivityData, GovernanceProductivityQuery>, unknown>()(
    "GET",
    "/admin/productivity",
    productivitySchema,
    productivityQuerySchema,
  ),
  benchmarkUsers: operation<WithQuery<GetAdminBenchmarkUsersData, GovernanceWindowLimitQuery>, unknown>()(
    "GET",
    "/admin/benchmark/users",
    benchmarkUsersSchema,
    windowLimitQuerySchema,
  ),
  benchmarkTeams: operation<WithQuery<GetAdminBenchmarkTeamsData, GovernanceWindowQuery>, unknown>()(
    "GET",
    "/admin/benchmark/teams",
    benchmarkTeamsSchema,
    windowQuerySchema,
  ),
  sbom: operation<GetAdminSbomData, unknown>()("GET", "/admin/sbom", sbomSchema),
  personalization: {
    profiles: operation<
      WithQuery<GetAdminPersonalizationProfilesData, GovernanceWindowLimitQuery>,
      unknown
    >()("GET", "/admin/personalization/profiles", profilesSchema, windowLimitQuerySchema),
    profile: personalizationProfileDetail,
    profileSnapshot: personalizationProfileSnapshot,
    coaching: operation<
      WithQuery<GetAdminPersonalizationCoachingData, GovernanceWindowLimitQuery>,
      unknown
    >()("GET", "/admin/personalization/coaching", coachingSchema, windowLimitQuerySchema),
    modelAffinity: operation<
      WithQuery<GetAdminPersonalizationModelAffinityData, GovernanceWindowLimitQuery>,
      unknown
    >()("GET", "/admin/personalization/model-affinity", modelAffinitySchema, windowLimitQuerySchema),
    mcpAffinity: operation<
      WithQuery<GetAdminPersonalizationMcpAffinityData, GovernanceWindowLimitQuery>,
      unknown
    >()("GET", "/admin/personalization/mcp-affinity", mcpAffinitySchema, windowLimitQuerySchema),
    text2sqlHints: operation<
      WithQuery<GetAdminPersonalizationText2SqlHintsData, GovernanceHintsQuery>,
      unknown
    >()("GET", "/admin/personalization/text2sql-hints", text2sqlHintsSchema, hintsQuerySchema),
  },
  recommendationAdoption: operation<
    WithQuery<GetAdminRecommendationsAdoptionData, GovernanceWindowQuery>,
    unknown
  >()("GET", "/admin/recommendations/adoption", adoptionSchema, windowQuerySchema),
} as const;
