import { z } from "zod";

import { operation, type WithQuery } from "@/shared/api/endpoint-factory";
import type {
  GetAdminWorkIntelAutomationData,
  GetAdminWorkIntelAutomationResponse,
  GetAdminWorkIntelCategoriesData,
  GetAdminWorkIntelCategoriesResponse,
  GetAdminWorkIntelFlowData,
  GetAdminWorkIntelFlowResponse,
  GetAdminWorkIntelInsightsData,
  GetAdminWorkIntelInsightsResponse,
  GetAdminWorkIntelMatrixData,
  GetAdminWorkIntelMatrixResponse,
  GetAdminWorkIntelModelsData,
  GetAdminWorkIntelModelsResponse,
  GetAdminWorkIntelOverviewData,
  GetAdminWorkIntelOverviewResponse,
  GetAdminWorkIntelProductivityData,
  GetAdminWorkIntelProductivityResponse,
  GetAdminWorkIntelRequestsData,
  GetAdminWorkIntelRequestsResponse,
  GetAdminWorkIntelSessionsData,
  GetAdminWorkIntelSessionsIdData,
  GetAdminWorkIntelSessionsIdResponse,
  GetAdminWorkIntelSessionsResponse,
  GetAdminWorkIntelStatusData,
  GetAdminWorkIntelStatusResponse,
  GetAdminWorkIntelTeamsData,
  GetAdminWorkIntelTeamsResponse,
  GetAdminWorkIntelTrendData,
  GetAdminWorkIntelTrendResponse,
  GetAdminWorkIntelTrendsData,
  GetAdminWorkIntelTrendsResponse,
  PostAdminWorkIntelAutomationIdReviewData,
  PostAdminWorkIntelAutomationIdReviewResponse,
  PostAdminWorkIntelInsightsRunData,
  PostAdminWorkIntelInsightsRunResponse,
} from "@/shared/api/generated";
import {
  categoryRefSchema,
  metricsSchema,
  scopeSchema,
  workQuerySchema,
  withheldNumber,
  workRequestSchema,
  type WorkMetrics,
  type WorkQuery,
} from "@/shared/api/domains/insights-common";
import { looseObject, orDefault } from "@/shared/api/loose";

// Work-usage analytics reads (docs/WORK_INTELLIGENCE_DESIGN.md §7). The server
// documents every response as an open object, so these schemas are the contract
// the screen reads them by: a missing field falls back to an empty value and an
// unknown enum value stays a string, so one new server value never blanks a panel.

const text = orDefault(z.string(), "");
const count = orDefault(z.number(), 0);
const flag = orDefault(z.boolean(), false);
const nullableNumber = orDefault(z.number().nullable(), null);
const strings = orDefault(z.array(z.string()), []);
/** A series over time; `null` is a bucket withheld to protect a small group. */
const withheldSeries = orDefault(z.array(z.number().nullable()), []);

const emptyMetrics: WorkMetrics = {
  sessions: 0,
  requests: 0,
  users: null,
  tokens: 0,
  cost_krw: 0,
  mcp_calls: 0,
  suppressed: false,
};
const metrics = orDefault(metricsSchema, emptyMetrics);
const previousMetrics = orDefault(metricsSchema.nullable(), null);

// ── Overview ────────────────────────────────────────────────────────────────

/** The period-level figures are `null` too when the period itself is withheld; teams and candidates never are. */
const overviewMetricsSchema = metricsSchema.extend({
  teams: count,
  active_categories: withheldNumber,
  classified_rate: withheldNumber,
  new_categories: withheldNumber,
  automation_candidates: count,
});
export type WorkOverviewMetrics = z.output<typeof overviewMetricsSchema>;

const overviewSchema = looseObject({
  scope: scopeSchema,
  current: overviewMetricsSchema,
  previous: orDefault(overviewMetricsSchema.nullable(), null),
  /** `null` without a base, or when either period is withheld. */
  growth_rate: nullableNumber,
  /** Empty when `current.suppressed`, and always for a caller with `scope.small_groups_withheld`. */
  confidence: orDefault(z.array(looseObject({ bucket: text, requests: count })), []),
  methods: orDefault(z.array(looseObject({ method: text, requests: count })), []),
  statuses: orDefault(z.array(looseObject({ status: text, requests: count })), []),
});
export type WorkOverview = z.output<typeof overviewSchema>;

// ── Categories ──────────────────────────────────────────────────────────────

const categoryRowSchema = looseObject({
  category: categoryRefSchema,
  current: metrics,
  previous: previousMetrics,
  /** `null` when the row's current period is withheld. */
  share: nullableNumber,
  /** `null` without a base, or when either period is withheld. */
  delta: nullableNumber,
  has_children: flag,
  /** Mirrors `current.suppressed`. */
  suppressed: flag,
});
export type WorkCategoryRow = z.output<typeof categoryRowSchema>;

/**
 * When the level's total is too small to show, `rows` is empty and `total`,
 * `unclassified` and `failed` are all withheld Metrics.
 */
const categoriesSchema = looseObject({
  scope: scopeSchema,
  parent: orDefault(categoryRefSchema.nullable(), null),
  rows: orDefault(z.array(categoryRowSchema), []),
  unclassified: metrics,
  failed: metrics,
  total: metrics,
});
export type WorkCategories = z.output<typeof categoriesSchema>;

export const categoriesQuerySchema = workQuerySchema.extend({ parent: z.string().max(128).optional() });
export type WorkCategoriesQuery = z.input<typeof categoriesQuerySchema>;

// ── Trend (one series per category over time) ───────────────────────────────

/**
 * Categories too small over the whole period have no series of their own: they are
 * in `other`. `suppressed` means the whole scope is too small to show: the series
 * are empty on purpose.
 */
const trendSchema = looseObject({
  scope: scopeSchema,
  buckets: strings,
  series: orDefault(z.array(looseObject({ category: categoryRefSchema, values: withheldSeries })), []),
  other: withheldSeries,
  total: withheldSeries,
  suppressed: flag,
});
export type WorkTrend = z.output<typeof trendSchema>;

export const workTrendBuckets = ["day", "week"] as const;
export type WorkTrendBucket = (typeof workTrendBuckets)[number];

const top = z.number().int().min(1).max(100).optional();
export const trendQuerySchema = workQuerySchema.extend({ bucket: z.enum(workTrendBuckets).optional(), top });
export type WorkTrendQuery = z.input<typeof trendQuerySchema>;

// ── Matrix (team × category heatmap) ────────────────────────────────────────

const matrixCellSchema = looseObject({
  category_id: z.string(),
  value: nullableNumber,
  users: nullableNumber,
  suppressed: flag,
});
export type WorkMatrixCell = z.output<typeof matrixCellSchema>;

const matrixSchema = looseObject({
  scope: scopeSchema,
  categories: orDefault(z.array(categoryRefSchema), []),
  rows: orDefault(
    z.array(looseObject({ team: text, total: metrics, cells: orDefault(z.array(matrixCellSchema), []) })),
    [],
  ),
});
export type WorkMatrix = z.output<typeof matrixSchema>;

export const topQuerySchema = workQuerySchema.extend({ top });
export type WorkTopQuery = z.input<typeof topQuerySchema>;

// ── Flow (team → category → model) ──────────────────────────────────────────

/**
 * Small teams, categories and models are folded into their column's "기타" node
 * (`team:기타`, …); a link whose population is too small is left out and counted
 * in `suppressed_links`. A node's value is the sum of its visible links.
 */
const flowSchema = looseObject({
  scope: scopeSchema,
  nodes: orDefault(z.array(looseObject({ id: z.string(), kind: text, name: text, value: count })), []),
  links: orDefault(z.array(looseObject({ source: z.string(), target: z.string(), value: count })), []),
  suppressed_links: count,
  /** The scope is too small to show, or every link was withheld: nodes and links are empty on purpose. */
  suppressed: flag,
});
export type WorkFlow = z.output<typeof flowSchema>;

// ── Teams ───────────────────────────────────────────────────────────────────

const teamRowSchema = looseObject({
  team: text,
  current: metrics,
  previous: previousMetrics,
  sessions_per_user: nullableNumber,
  /** `null` when the row is withheld. Withheld cells are simply left out of the lists below. */
  diversity: nullableNumber,
  top_categories: orDefault(
    z.array(looseObject({ category: categoryRefSchema, value: count, share: count })),
    [],
  ),
  rising: orDefault(z.array(looseObject({ category: categoryRefSchema, delta: count })), []),
  deviation: orDefault(
    z.array(looseObject({ category: categoryRefSchema, team_share: count, overall_share: count })),
    [],
  ),
  suppressed: flag,
});
export type WorkTeamRow = z.output<typeof teamRowSchema>;

const teamsSchema = looseObject({
  scope: scopeSchema,
  rows: orDefault(z.array(teamRowSchema), []),
  denominators: orDefault(z.string(), "active_users"),
});
export type WorkTeams = z.output<typeof teamsSchema>;

// ── Models ──────────────────────────────────────────────────────────────────

/** A withheld row (`suppressed`) keeps its category and model but every measure is `null`. */
const modelRowSchema = looseObject({
  category: categoryRefSchema,
  model: text,
  provider: text,
  requests: withheldNumber,
  sessions: withheldNumber,
  share: withheldNumber,
  tokens_per_session: withheldNumber,
  cost_per_session: withheldNumber,
  latency_p50_ms: withheldNumber,
  latency_p95_ms: withheldNumber,
  error_rate: withheldNumber,
  retry_rate: withheldNumber,
  model_switch_rate: withheldNumber,
  feedback_positive: withheldNumber,
  feedback_negative: withheldNumber,
  /** Meaningless on a withheld row. */
  low_sample: flag,
  suppressed: flag,
});
export type WorkModelRow = z.output<typeof modelRowSchema>;

const modelSuggestionSchema = looseObject({
  category: categoryRefSchema,
  from_model: text,
  to_model: text,
  basis: text,
  sample: count,
  est_saving_krw: count,
});
export type WorkModelSuggestion = z.output<typeof modelSuggestionSchema>;

const modelsSchema = looseObject({
  scope: scopeSchema,
  rows: orDefault(z.array(modelRowSchema), []),
  suggestions: orDefault(z.array(modelSuggestionSchema), []),
  /** The scope is too small to show, or every row was withheld: rows are empty on purpose. */
  suppressed: flag,
});
export type WorkModels = z.output<typeof modelsSchema>;

// ── Trend signals ───────────────────────────────────────────────────────────

export const workSignalKinds = [
  "rising_7d",
  "rising_30d",
  "new",
  "team_concentrated",
  "spreading",
  "declining",
  "cost_spike",
  "model_dependence",
] as const;
export type WorkSignalKind = (typeof workSignalKinds)[number];

const signalSchema = looseObject({
  kind: text,
  category: categoryRefSchema,
  team: text,
  model: text,
  current: count,
  previous: count,
  change_abs: count,
  change_rate: nullableNumber,
  users_current: nullableNumber,
  users_previous: nullableNumber,
  sample: count,
  note: text,
});
export type WorkSignal = z.output<typeof signalSchema>;

const trendsSchema = looseObject({
  scope: scopeSchema,
  signals: orDefault(z.array(signalSchema), []),
  thresholds: orDefault(looseObject({ min_sample: count, min_change_abs: count, min_change_rate: count }), {
    min_sample: 0,
    min_change_abs: 0,
    min_change_rate: 0,
  }),
});
export type WorkTrends = z.output<typeof trendsSchema>;

// ── Automation candidates ───────────────────────────────────────────────────

export const automationReviewStatuses = ["new", "reviewing", "accepted", "dismissed"] as const;
export type AutomationReviewStatus = (typeof automationReviewStatuses)[number];

const automationRowSchema = looseObject({
  id: z.string(),
  title: text,
  category: categoryRefSchema,
  teams: strings,
  repeats: count,
  users: nullableNumber,
  sessions: count,
  cost_krw: count,
  avg_latency_ms: count,
  recommended: text,
  feasibility: count,
  mcp_tools: strings,
  risk: text,
  needs_approval: flag,
  effect: orDefault(
    looseObject({ basis: text, est_minutes_saved: nullableNumber, est_cost_saved_krw: nullableNumber }),
    { basis: "", est_minutes_saved: null, est_cost_saved_krw: null },
  ),
  review_status: orDefault(z.string(), "new"),
  computed_at: text,
});
export type WorkAutomationRow = z.output<typeof automationRowSchema>;

const automationSchema = looseObject({
  scope: scopeSchema,
  rows: orDefault(z.array(automationRowSchema), []),
  count,
});
export type WorkAutomation = z.output<typeof automationSchema>;

// ── Insights ────────────────────────────────────────────────────────────────

const insightSchema = looseObject({
  id: z.string(),
  kind: text,
  severity: orDefault(z.string(), "info"),
  title: text,
  body: text,
  evidence: orDefault(
    looseObject({
      period: text,
      compare: text,
      sample: count,
      metrics: orDefault(z.record(z.string(), z.number()), {}),
    }),
    { period: "", compare: "", sample: 0, metrics: {} },
  ),
  link: orDefault(z.record(z.string(), z.union([z.string(), z.number()]).transform(String)), {}),
  created_at: text,
});
export type WorkInsight = z.output<typeof insightSchema>;

const insightsSchema = looseObject({
  scope: scopeSchema,
  rows: orDefault(z.array(insightSchema), []),
  generated_at: text,
  llm_used: flag,
});
export type WorkInsights = z.output<typeof insightsSchema>;

const insightsRunSchema = looseObject({ generated: count, generated_at: text });

// ── Sessions and requests ───────────────────────────────────────────────────

const sessionRowSchema = looseObject({
  session_id: z.string(),
  session_kind: text,
  team: text,
  user: text,
  client: text,
  primary: categoryRefSchema,
  secondary: orDefault(z.array(categoryRefSchema), []),
  first_at: text,
  last_at: text,
  requests: count,
  mcp_calls: count,
  tokens_in: count,
  tokens_out: count,
  cost_krw: count,
  duration_ms: count,
  model_time_ms: count,
  errors: count,
  retries: count,
  models: strings,
  model_switches: count,
  policy_flags: strings,
  completion: orDefault(z.string(), "unknown"),
});
export type WorkSessionRow = z.output<typeof sessionRowSchema>;

const sessionsSchema = looseObject({
  scope: scopeSchema,
  rows: orDefault(z.array(sessionRowSchema), []),
  count,
  limit: count,
  offset: count,
});
export type WorkSessions = z.output<typeof sessionsSchema>;

export const sessionsQuerySchema = workQuerySchema.extend({
  sort: z.string().max(64).optional(),
  session_status: z.string().max(32).optional(),
});
export type WorkSessionsQuery = z.input<typeof sessionsQuerySchema>;

const sessionDetailSchema = looseObject({
  session: sessionRowSchema,
  segments: orDefault(
    z.array(
      looseObject({
        category: categoryRefSchema,
        requests: count,
        cost_krw: count,
        first_at: text,
        last_at: text,
      }),
    ),
    [],
  ),
  requests: orDefault(z.array(workRequestSchema), []),
});
export type WorkSessionDetail = z.output<typeof sessionDetailSchema>;

const requestsSchema = looseObject({
  scope: scopeSchema,
  rows: orDefault(z.array(workRequestSchema), []),
  count,
  limit: count,
  offset: count,
});
export type WorkRequests = z.output<typeof requestsSchema>;

const confidence = z.number().min(0).max(1).optional();
export const requestsQuerySchema = workQuerySchema.extend({
  min_conf: confidence,
  max_conf: confidence,
  method: z.string().max(32).optional(),
});
export type WorkRequestsQuery = z.input<typeof requestsQuerySchema>;

// ── Productivity ────────────────────────────────────────────────────────────

/** A withheld row (`suppressed`) has its observed and estimated figures `null` and says why in `reason`. */
const productivityRowSchema = looseObject({
  category: categoryRefSchema,
  sessions: withheldNumber,
  confirmed_sessions: withheldNumber,
  model_time_ms: withheldNumber,
  baseline: orDefault(
    looseObject({ manual_minutes: count, ai_minutes: count, hourly_cost_krw: count }).nullable(),
    null,
  ),
  est_minutes_saved: nullableNumber,
  est_cost_saved_krw: nullableNumber,
  reason: text,
  suppressed: flag,
});
export type WorkProductivityRow = z.output<typeof productivityRowSchema>;

const productivitySchema = looseObject({
  scope: scopeSchema,
  rows: orDefault(z.array(productivityRowSchema), []),
  /** The scope is too small to show, or every row was withheld: rows are empty on purpose. */
  suppressed: flag,
});
export type WorkProductivity = z.output<typeof productivitySchema>;

// ── Worker status ───────────────────────────────────────────────────────────

const statusSchema = looseObject({
  classify_enabled: orDefault(z.boolean(), true),
  analytics_enabled: orDefault(z.boolean(), true),
  llm_enabled: flag,
  llm_model: text,
  llm_external_allowed: flag,
  policy_version: count,
  cursor_at: text,
  lag_seconds: count,
  backlog: count,
  last_run_at: text,
  last_error: text,
  processed_total: count,
  processed_24h: count,
  by_method: orDefault(z.record(z.string(), z.number()), {}),
  failures_24h: count,
  llm_calls_24h: count,
  llm_tokens_24h: count,
  llm_cost_krw_24h: count,
  cache_hits_24h: count,
  worker_active: flag,
});
export type WorkStatus = z.output<typeof statusSchema>;

// ── CSV export ──────────────────────────────────────────────────────────────

export const workExportViews = ["categories", "teams", "models", "sessions", "requests"] as const;
export type WorkExportView = (typeof workExportViews)[number];

/** Query of `GET /admin/work-intel/export.csv`: the analytics filters plus the table to export. */
export const workExportQuerySchema = workQuerySchema.extend({ view: z.enum(workExportViews) });
export type WorkExportQuery = z.input<typeof workExportQuerySchema>;

// ── Endpoints ───────────────────────────────────────────────────────────────

export const insightsUsageEndpoints = {
  overview: operation<
    WithQuery<GetAdminWorkIntelOverviewData, WorkQuery>,
    GetAdminWorkIntelOverviewResponse
  >()("GET", "/admin/work-intel/overview", overviewSchema, workQuerySchema),
  categories: operation<
    WithQuery<GetAdminWorkIntelCategoriesData, WorkCategoriesQuery>,
    GetAdminWorkIntelCategoriesResponse
  >()("GET", "/admin/work-intel/categories", categoriesSchema, categoriesQuerySchema),
  trend: operation<WithQuery<GetAdminWorkIntelTrendData, WorkTrendQuery>, GetAdminWorkIntelTrendResponse>()(
    "GET",
    "/admin/work-intel/trend",
    trendSchema,
    trendQuerySchema,
  ),
  matrix: operation<WithQuery<GetAdminWorkIntelMatrixData, WorkTopQuery>, GetAdminWorkIntelMatrixResponse>()(
    "GET",
    "/admin/work-intel/matrix",
    matrixSchema,
    topQuerySchema,
  ),
  flow: operation<WithQuery<GetAdminWorkIntelFlowData, WorkTopQuery>, GetAdminWorkIntelFlowResponse>()(
    "GET",
    "/admin/work-intel/flow",
    flowSchema,
    topQuerySchema,
  ),
  teams: operation<WithQuery<GetAdminWorkIntelTeamsData, WorkQuery>, GetAdminWorkIntelTeamsResponse>()(
    "GET",
    "/admin/work-intel/teams",
    teamsSchema,
    workQuerySchema,
  ),
  models: operation<WithQuery<GetAdminWorkIntelModelsData, WorkQuery>, GetAdminWorkIntelModelsResponse>()(
    "GET",
    "/admin/work-intel/models",
    modelsSchema,
    workQuerySchema,
  ),
  trends: operation<WithQuery<GetAdminWorkIntelTrendsData, WorkQuery>, GetAdminWorkIntelTrendsResponse>()(
    "GET",
    "/admin/work-intel/trends",
    trendsSchema,
    workQuerySchema,
  ),
  automation: operation<
    WithQuery<GetAdminWorkIntelAutomationData, WorkQuery>,
    GetAdminWorkIntelAutomationResponse
  >()("GET", "/admin/work-intel/automation", automationSchema, workQuerySchema),
  /** Records a review decision only; nothing is registered or executed. Bind `{id}` with `withPathParams`. */
  automationReview: operation<
    PostAdminWorkIntelAutomationIdReviewData,
    PostAdminWorkIntelAutomationIdReviewResponse
  >()("POST", "/admin/work-intel/automation/{id}/review", automationRowSchema),
  insights: operation<
    WithQuery<GetAdminWorkIntelInsightsData, WorkQuery>,
    GetAdminWorkIntelInsightsResponse
  >()("GET", "/admin/work-intel/insights", insightsSchema, workQuerySchema),
  insightsRun: operation<PostAdminWorkIntelInsightsRunData, PostAdminWorkIntelInsightsRunResponse>()(
    "POST",
    "/admin/work-intel/insights/run",
    insightsRunSchema,
  ),
  sessions: operation<
    WithQuery<GetAdminWorkIntelSessionsData, WorkSessionsQuery>,
    GetAdminWorkIntelSessionsResponse
  >()("GET", "/admin/work-intel/sessions", sessionsSchema, sessionsQuerySchema),
  /** Bind `{id}` with `withPathParams`. */
  session: operation<GetAdminWorkIntelSessionsIdData, GetAdminWorkIntelSessionsIdResponse>()(
    "GET",
    "/admin/work-intel/sessions/{id}",
    sessionDetailSchema,
  ),
  requests: operation<
    WithQuery<GetAdminWorkIntelRequestsData, WorkRequestsQuery>,
    GetAdminWorkIntelRequestsResponse
  >()("GET", "/admin/work-intel/requests", requestsSchema, requestsQuerySchema),
  productivity: operation<
    WithQuery<GetAdminWorkIntelProductivityData, WorkQuery>,
    GetAdminWorkIntelProductivityResponse
  >()("GET", "/admin/work-intel/productivity", productivitySchema, workQuerySchema),
  status: operation<GetAdminWorkIntelStatusData, GetAdminWorkIntelStatusResponse>()(
    "GET",
    "/admin/work-intel/status",
    statusSchema,
  ),
} as const;
