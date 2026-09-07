// redteam domain endpoints. Declare every server call this domain's screens make
// here with `operation()` from "@/shared/api/endpoint-factory" and a zod schema
// (see "@/shared/api/loose" for legacy responses without a documented shape).
import { z } from "zod";

import type {
  DeleteAdminRedteamCampaignsIdData,
  DeleteAdminRedteamProbeCasesIdData,
  GetAdminRedteamBaselinesData,
  GetAdminRedteamCampaignsData,
  GetAdminRedteamDashboardData,
  GetAdminRedteamKillSwitchData,
  GetAdminRedteamProbePacksData,
  GetAdminRedteamRemediationsData,
  GetAdminRedteamResultsIdEvidenceData,
  GetAdminRedteamRunsIdResultsData,
  GetAdminRedteamRunsData,
  GetAdminRedteamSchedulesData,
  GetAdminRedteamTargetsData,
  GetAdminRedteamTargetsIdData,
  PostAdminRedteamCampaignsData,
  PostAdminRedteamCampaignsIdApproveData,
  PostAdminRedteamCampaignsIdDryRunData,
  PostAdminRedteamCampaignsIdRunData,
  PostAdminRedteamKillSwitchData,
  PostAdminRedteamProbeCasesData,
  PostAdminRedteamRemediationsIdApplyData,
  PostAdminRedteamRemediationsIdData,
  PostAdminRedteamResultsIdRemediationData,
  PostAdminRedteamResultsIdRerunData,
  PostAdminRedteamSchedulesData,
} from "@/shared/api/generated";
import type { OpenApiPath } from "@/shared/api/generated/paths.gen";
import { operation, pathWithParams, type OperationData } from "@/shared/api/endpoint-factory";
import { looseObject, numberish, orDefault, unknownRecord } from "@/shared/api/loose";

// The generated `…Data` types for the legacy admin surface document neither a request
// body nor a response payload (`body?: never`, `200: unknown`). `WithBody` restores the
// body the server actually reads (see internal/proxy/admin_redteam*.go); the zod schemas
// below are the response contract.
type WithBody<Data extends OperationData, Body> = Omit<Data, "body"> & { readonly body: Body };

/** Fills `{id}` in a declared endpoint path so the client calls the concrete resource. */
export function withPathParams<Endpoint extends { readonly path: OpenApiPath }>(
  endpoint: Endpoint,
  params: Readonly<Record<string, string | number>>,
): Endpoint {
  return { ...endpoint, path: pathWithParams(endpoint.path, params) };
}

const text = (fallback = "") => orDefault(z.string(), fallback);
const flag = (fallback = false) => orDefault(z.boolean(), fallback);
const count = (fallback = 0) => orDefault(numberish, fallback);
const textList = () => orDefault(z.array(z.string()), []);
const record = () => orDefault(unknownRecord, {});

export const redTeamTargetSchema = looseObject({
  id: text(),
  target_type: text(),
  target_ref: text(),
  provider: text(),
  model: text(),
  mcp_upstream: text(),
  tool_name: text(),
  owner_team: text(),
  risk_level: text(),
  enabled: flag(),
  metadata: record(),
  created_at: text(),
  updated_at: text(),
});

export const redTeamProbeCaseSchema = looseObject({
  id: text(),
  pack_id: text(),
  case_key: text(),
  input_template: text(),
  expected_policy: text(),
  evaluator_type: text(),
  severity: text(),
  risk_tags: textList(),
  target_types: textList(),
  parameters: record(),
});

export const redTeamProbePackSchema = looseObject({
  id: text(),
  name: text(),
  category: text(),
  severity: text(),
  version: text(),
  enabled: flag(),
  requires_approval: flag(),
  created_by: text(),
  created_at: text(),
  updated_at: text(),
  cases: orDefault(z.array(redTeamProbeCaseSchema), []),
});

export const redTeamCampaignSchema = looseObject({
  id: text(),
  name: text(),
  scope: text(),
  status: text(),
  execution_mode: text(),
  created_by: text(),
  approved_by: text(),
  budget_limit_krw: count(),
  qps_limit: count(),
  timeout_ms: count(),
  concurrency: count(),
  target_filter: record(),
  probe_pack_ids: textList(),
  evidence_retention_days: count(),
  external_provider_allowed: flag(),
  destructive_tool_policy: text(),
  retain_raw_evidence: flag(),
  trigger_source: text(),
  trigger_action: text(),
  trigger_ref: text(),
  trigger_reason: text(),
  created_at: text(),
  updated_at: text(),
});

export const redTeamRunSchema = looseObject({
  id: text(),
  campaign_id: text(),
  target_id: text(),
  started_at: text(),
  ended_at: text(),
  status: text(),
  total_cases: count(),
  failed_cases: count(),
  risk_score: count(),
  cost_krw: count(),
  mode: text(),
  created_at: text(),
});

export const redTeamCaseResultSchema = looseObject({
  id: text(),
  run_id: text(),
  case_id: text(),
  request_id: text(),
  decision: text(),
  severity: text(),
  evidence_hash: text(),
  policy_decision: text(),
  latency_ms: count(),
  cost_krw: count(),
  created_at: text(),
});

export const redTeamEvidenceSchema = looseObject({
  id: text(),
  result_id: text(),
  masked_prompt: text(),
  masked_response: text(),
  raw_prompt: text(),
  raw_response: text(),
  tool_calls: orDefault(z.array(unknownRecord), []),
  headers_summary: record(),
  export_hash: text(),
  created_at: text(),
});

export const redTeamRemediationSchema = looseObject({
  id: text(),
  result_id: text(),
  action_type: text(),
  action_payload: record(),
  status: text("open"),
  owner: text(),
  due_date: text(),
  created_at: text(),
  updated_at: text(),
});

export const redTeamBaselineSchema = looseObject({
  id: text(),
  target_id: text(),
  pack_id: text(),
  baseline_score: count(),
  last_passed_at: text(),
  drift_threshold: count(),
  updated_at: text(),
});

export const redTeamScheduleSchema = looseObject({
  id: text(),
  campaign_template_id: text(),
  cron_expr: text(),
  timezone: text(),
  enabled: flag(),
  last_run_at: text(),
  created_at: text(),
  updated_at: text(),
});

const targetListSchema = looseObject({
  targets: orDefault(z.array(redTeamTargetSchema), []),
  count: count(),
  note: text(),
});

const probePackListSchema = looseObject({
  probe_packs: orDefault(z.array(redTeamProbePackSchema), []),
  count: count(),
});

const campaignListSchema = looseObject({
  campaigns: orDefault(z.array(redTeamCampaignSchema), []),
  count: count(),
  post_change: orDefault(
    looseObject({
      enabled: flag(),
      cooldown: text(),
      max_targets: count(),
      mode: text(),
    }),
    { enabled: false, cooldown: "", max_targets: 0, mode: "" },
  ),
});

const runListSchema = looseObject({
  runs: orDefault(z.array(redTeamRunSchema), []),
  count: count(),
});

const runResultsSchema = looseObject({
  run: orDefault(redTeamRunSchema, {
    id: "",
    campaign_id: "",
    target_id: "",
    started_at: "",
    ended_at: "",
    status: "",
    total_cases: 0,
    failed_cases: 0,
    risk_score: 0,
    cost_krw: 0,
    mode: "",
    created_at: "",
  }),
  results: orDefault(z.array(redTeamCaseResultSchema), []),
  // Short masked prompt preview keyed by result id (server-side join, never raw text).
  prompts: orDefault(z.record(z.string(), z.string()), {}),
  count: count(),
});

const remediationListSchema = looseObject({
  remediations: orDefault(z.array(redTeamRemediationSchema), []),
  count: count(),
});

const baselineListSchema = looseObject({
  baselines: orDefault(z.array(redTeamBaselineSchema), []),
  count: count(),
});

const scheduleListSchema = looseObject({
  schedules: orDefault(z.array(redTeamScheduleSchema), []),
  count: count(),
  note: text(),
});

export const redTeamMatrixCellSchema = looseObject({
  target_type: text(),
  pack_category: text(),
  pass: count(),
  warning: count(),
  fail: count(),
  critical: count(),
  inconclusive: count(),
  total: count(),
});

export const redTeamFailingTargetSchema = looseObject({
  target_id: text(),
  target_ref: text(),
  target_type: text(),
  owner_team: text(),
  critical: count(),
  fail: count(),
  warning: count(),
  max_risk: count(),
});

export const redTeamDriftSchema = looseObject({
  target_id: text(),
  pack_id: text(),
  baseline_score: count(),
  current_score: count(),
  delta: count(),
  threshold: count(),
  last_passed_at: text(),
});

const dashboardSchema = looseObject({
  summary: orDefault(
    looseObject({
      total_results: count(),
      by_decision: orDefault(z.record(z.string(), numberish), {}),
      max_risk: count(),
      open_remediations: count(),
      external_targets: count(),
      drift_count: count(),
    }),
    {
      total_results: 0,
      by_decision: {},
      max_risk: 0,
      open_remediations: 0,
      external_targets: 0,
      drift_count: 0,
    },
  ),
  matrix: orDefault(z.array(redTeamMatrixCellSchema), []),
  top_failing_targets: orDefault(z.array(redTeamFailingTargetSchema), []),
  drift: orDefault(z.array(redTeamDriftSchema), []),
  note: text(),
});

const killSwitchSchema = looseObject({ enabled: flag() });

export const redTeamDryRunSchema = looseObject({
  campaign_id: text(),
  targets: count(),
  probe_packs: count(),
  case_executions: count(),
  estimated_cost_krw: count(),
  external_targets: count(),
  destructive_tool_targets: count(),
  active_eligible_targets: count(),
  models_selected: count(),
  requires_approval: flag(),
  approved: flag(),
  can_run: flag(),
  limits: orDefault(
    looseObject({
      budget_limit_krw: count(),
      qps_limit: count(),
      concurrency: count(),
      timeout_ms: count(),
    }),
    { budget_limit_krw: 0, qps_limit: 0, concurrency: 0, timeout_ms: 0 },
  ),
  note: text(),
});

export const redTeamRunOutcomeSchema = looseObject({
  campaign_id: text(),
  status: text(),
  stopped: text(),
  runs: orDefault(z.array(redTeamRunSchema), []),
  summary: orDefault(
    looseObject({
      runs: count(),
      results: count(),
      warnings: count(),
      failures: count(),
      critical: count(),
      live_calls: count(),
      live_cost_krw: count(),
      mode: text(),
    }),
    {
      runs: 0,
      results: 0,
      warnings: 0,
      failures: 0,
      critical: 0,
      live_calls: 0,
      live_cost_krw: 0,
      mode: "",
    },
  ),
  note: text(),
});

export const redTeamRerunSchema = looseObject({
  result_id: text(),
  decision: text(),
  policy_decision: text(),
  severity: text(),
  cost_krw: count(),
  note: text(),
});

export const redTeamApplyRemediationSchema = looseObject({
  remediation: redTeamRemediationSchema,
  applied: flag(),
  outcome: text(),
});

/** `POST /admin/redteam/probe-packs/import` — parsed from a raw `fetch` (text/csv body). */
export const redTeamImportResultSchema = looseObject({
  imported_cases: count(),
  packs_touched: count(),
  skipped: textList(),
});

export interface RedTeamCampaignInput {
  readonly id?: string;
  readonly name: string;
  readonly scope: string;
  readonly execution_mode: string;
  readonly budget_limit_krw: number;
  readonly qps_limit: number;
  readonly destructive_tool_policy: string;
  readonly retain_raw_evidence: boolean;
  readonly probe_pack_ids: readonly string[];
  readonly target_filter: Readonly<Record<string, unknown>>;
}

export interface RedTeamProbeCaseInput {
  readonly case_id?: string;
  readonly pack_id?: string;
  readonly pack_name?: string;
  readonly case_key: string;
  readonly input_template: string;
  readonly expected_policy: string;
  readonly evaluator_type: string;
  readonly severity: string;
  readonly target_types: readonly string[];
}

export interface RedTeamScheduleInput {
  readonly id?: string;
  readonly campaign_template_id: string;
  readonly cron_expr: string;
  readonly timezone?: string;
  readonly enabled: boolean;
}

export const redteamEndpoints = {
  targets: {
    list: operation<GetAdminRedteamTargetsData, unknown>()("GET", "/admin/redteam/targets", targetListSchema),
    detail: operation<GetAdminRedteamTargetsIdData, unknown>()(
      "GET",
      "/admin/redteam/targets/{id}",
      looseObject({ target: redTeamTargetSchema }),
    ),
  },
  probePacks: {
    list: operation<GetAdminRedteamProbePacksData, unknown>()(
      "GET",
      "/admin/redteam/probe-packs",
      probePackListSchema,
    ),
  },
  probeCases: {
    upsert: operation<WithBody<PostAdminRedteamProbeCasesData, RedTeamProbeCaseInput>, unknown>()(
      "POST",
      "/admin/redteam/probe-cases",
      looseObject({ case: redTeamProbeCaseSchema, pack_id: text() }),
    ),
    remove: operation<DeleteAdminRedteamProbeCasesIdData, unknown>()(
      "DELETE",
      "/admin/redteam/probe-cases/{id}",
      looseObject({ id: text(), deleted: flag() }),
    ),
  },
  campaigns: {
    list: operation<GetAdminRedteamCampaignsData, unknown>()(
      "GET",
      "/admin/redteam/campaigns",
      campaignListSchema,
    ),
    upsert: operation<WithBody<PostAdminRedteamCampaignsData, RedTeamCampaignInput>, unknown>()(
      "POST",
      "/admin/redteam/campaigns",
      looseObject({ campaign: redTeamCampaignSchema }),
    ),
    remove: operation<DeleteAdminRedteamCampaignsIdData, unknown>()(
      "DELETE",
      "/admin/redteam/campaigns/{id}",
      looseObject({ id: text(), deleted: flag() }),
    ),
    dryRun: operation<PostAdminRedteamCampaignsIdDryRunData, unknown>()(
      "POST",
      "/admin/redteam/campaigns/{id}/dry-run",
      redTeamDryRunSchema,
    ),
    approve: operation<PostAdminRedteamCampaignsIdApproveData, unknown>()(
      "POST",
      "/admin/redteam/campaigns/{id}/approve",
      looseObject({ id: text(), status: text() }),
    ),
    run: operation<WithBody<PostAdminRedteamCampaignsIdRunData, { readonly proxy_key?: string }>, unknown>()(
      "POST",
      "/admin/redteam/campaigns/{id}/run",
      redTeamRunOutcomeSchema,
    ),
  },
  runs: {
    list: operation<GetAdminRedteamRunsData, unknown>()("GET", "/admin/redteam/runs", runListSchema),
    results: operation<GetAdminRedteamRunsIdResultsData, unknown>()(
      "GET",
      "/admin/redteam/runs/{id}/results",
      runResultsSchema,
    ),
  },
  results: {
    evidence: operation<GetAdminRedteamResultsIdEvidenceData, unknown>()(
      "GET",
      "/admin/redteam/results/{id}/evidence",
      looseObject({ evidence: redTeamEvidenceSchema }),
    ),
    rerun: operation<WithBody<PostAdminRedteamResultsIdRerunData, { readonly proxy_key: string }>, unknown>()(
      "POST",
      "/admin/redteam/results/{id}/rerun",
      redTeamRerunSchema,
    ),
    remediation: operation<
      WithBody<
        PostAdminRedteamResultsIdRemediationData,
        {
          readonly action_type: string;
          readonly action_payload: Readonly<Record<string, unknown>>;
          readonly owner?: string;
          readonly due_date?: string;
        }
      >,
      unknown
    >()(
      "POST",
      "/admin/redteam/results/{id}/remediation",
      looseObject({ remediation: redTeamRemediationSchema }),
    ),
  },
  remediations: {
    list: operation<GetAdminRedteamRemediationsData, unknown>()(
      "GET",
      "/admin/redteam/remediations",
      remediationListSchema,
    ),
    update: operation<
      WithBody<
        PostAdminRedteamRemediationsIdData,
        {
          readonly status?: string;
          readonly owner?: string;
          readonly due_date?: string;
          readonly note?: string;
        }
      >,
      unknown
    >()("POST", "/admin/redteam/remediations/{id}", looseObject({ remediation: redTeamRemediationSchema })),
    apply: operation<PostAdminRedteamRemediationsIdApplyData, unknown>()(
      "POST",
      "/admin/redteam/remediations/{id}/apply",
      redTeamApplyRemediationSchema,
    ),
  },
  baselines: {
    list: operation<GetAdminRedteamBaselinesData, unknown>()(
      "GET",
      "/admin/redteam/baselines",
      baselineListSchema,
    ),
  },
  dashboard: operation<GetAdminRedteamDashboardData, unknown>()(
    "GET",
    "/admin/redteam/dashboard",
    dashboardSchema,
  ),
  killSwitch: {
    read: operation<GetAdminRedteamKillSwitchData, unknown>()(
      "GET",
      "/admin/redteam/kill-switch",
      killSwitchSchema,
    ),
    set: operation<WithBody<PostAdminRedteamKillSwitchData, { readonly enabled: boolean }>, unknown>()(
      "POST",
      "/admin/redteam/kill-switch",
      killSwitchSchema,
    ),
  },
  schedules: {
    list: operation<GetAdminRedteamSchedulesData, unknown>()(
      "GET",
      "/admin/redteam/schedules",
      scheduleListSchema,
    ),
    upsert: operation<WithBody<PostAdminRedteamSchedulesData, RedTeamScheduleInput>, unknown>()(
      "POST",
      "/admin/redteam/schedules",
      looseObject({ schedule: redTeamScheduleSchema }),
    ),
  },
} as const;

export type RedTeamTarget = z.output<typeof redTeamTargetSchema>;
export type RedTeamProbePack = z.output<typeof redTeamProbePackSchema>;
export type RedTeamProbeCase = z.output<typeof redTeamProbeCaseSchema>;
export type RedTeamCampaign = z.output<typeof redTeamCampaignSchema>;
export type RedTeamRun = z.output<typeof redTeamRunSchema>;
export type RedTeamCaseResult = z.output<typeof redTeamCaseResultSchema>;
export type RedTeamEvidence = z.output<typeof redTeamEvidenceSchema>;
export type RedTeamRemediation = z.output<typeof redTeamRemediationSchema>;
export type RedTeamBaseline = z.output<typeof redTeamBaselineSchema>;
export type RedTeamSchedule = z.output<typeof redTeamScheduleSchema>;
export type RedTeamDashboard = z.output<typeof dashboardSchema>;
export type RedTeamMatrixCell = z.output<typeof redTeamMatrixCellSchema>;
export type RedTeamFailingTarget = z.output<typeof redTeamFailingTargetSchema>;
export type RedTeamDrift = z.output<typeof redTeamDriftSchema>;
export type RedTeamDryRun = z.output<typeof redTeamDryRunSchema>;
export type RedTeamRunOutcome = z.output<typeof redTeamRunOutcomeSchema>;
export type RedTeamCampaignList = z.output<typeof campaignListSchema>;
export type RedTeamImportResult = z.output<typeof redTeamImportResultSchema>;
