import { z } from "zod";

import { looseList, looseObject, numberish, unknownRecord } from "@/shared/api/loose";

// Response contracts for the AI gateway domain. The legacy admin API documents no
// response bodies, so the Go handlers in `internal/proxy/admin_*.go` are the source
// of truth and each screen declares only the fields it renders.

const acknowledgement = looseObject({ status: z.string().optional(), ok: z.boolean().optional() });

/* ── chat test targets ─────────────────────────────────────────────────────── */

export const chatTestTargetSchema = looseObject({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
  pattern: z.string().optional(),
  enabled: z.boolean().optional(),
  editable: z.boolean().optional(),
  description: z.string().optional(),
  metadata: unknownRecord.optional(),
});

export const chatTestTargetsSchema = looseObject({
  targets: z
    .array(chatTestTargetSchema)
    .nullish()
    .transform((value) => value ?? []),
  grouped: z.record(z.string(), z.array(chatTestTargetSchema)).nullish(),
  defaults: looseObject({
    model: z.string().optional(),
    prompt: z.string().optional(),
    max_tokens: numberish.optional(),
    temperature: numberish.optional(),
  }).nullish(),
  mcp_fetched_at: z.string().optional(),
  mcp_errors: z.unknown().optional(),
});

/* ── routing preview ───────────────────────────────────────────────────────── */

export const routingPreviewSchema = looseObject({
  requested_model: z.string().nullish(),
  selected_model: z.string().nullish(),
  selected_provider: z.string().nullish(),
  policy_api_key_id: z.string().nullish(),
  complexity: numberish.nullish(),
  risk: numberish.nullish(),
  health_score: numberish.nullish(),
  fallback_plan: z.array(z.string()).nullish(),
  route_reason: z.string().nullish(),
  decision_reason: z.string().nullish(),
  would_rewrite: z.boolean().nullish(),
});

/* ── code verification ─────────────────────────────────────────────────────── */

export const codeVerifyReportSchema = looseObject({
  has_code: z.boolean().nullish(),
  block_count: numberish.nullish(),
  languages: z.array(z.string()).nullish(),
  risk: z.string().nullish(),
  counts: z.record(z.string(), numberish).nullish(),
  blocks: looseList({
    index: numberish.nullish(),
    lang: z.string().nullish(),
    lines: numberish.nullish(),
    risk: z.string().nullish(),
    testable: z.boolean().nullish(),
    findings: looseList({
      severity: z.string().nullish(),
      rule: z.string().nullish(),
      lang: z.string().nullish(),
      line: numberish.nullish(),
      detail: z.string().nullish(),
    }).nullish(),
  }).nullish(),
  note: z.string().nullish(),
});

export const codeVerifyStatsSchema = looseObject({
  days: numberish.nullish(),
  models: looseList({
    model: z.string().nullish(),
    verdicts: numberish.nullish(),
    risk_high: numberish.nullish(),
    risk_medium: numberish.nullish(),
    secret_findings: numberish.nullish(),
  }).nullish(),
  totals: z.record(z.string(), numberish).nullish(),
  note: z.string().nullish(),
});

/* ── multi model comparison ────────────────────────────────────────────────── */

export const multiRunResultSchema = looseObject({
  model: z.string(),
  provider: z.string().nullish(),
  status: z.string().nullish(),
  status_code: numberish.nullish(),
  latency_ms: numberish.nullish(),
  input_tokens: numberish.nullish(),
  output_tokens: numberish.nullish(),
  total_tokens: numberish.nullish(),
  cost_krw_est: numberish.nullish(),
  content: z.string().nullish(),
  finish_reason: z.string().nullish(),
  error: z.string().nullish(),
  selected_provider: z.string().nullish(),
});

export const multiRunResponseSchema = looseObject({
  status: z.string().nullish(),
  run_id: z.string().nullish(),
  title: z.string().nullish(),
  summary: looseObject({
    total_models: numberish.nullish(),
    success: numberish.nullish(),
    failed: numberish.nullish(),
    best_latency_model: z.string().nullish(),
    lowest_cost_success_model: z.string().nullish(),
  }).nullish(),
  results: z
    .array(multiRunResultSchema)
    .nullish()
    .transform((value) => value ?? []),
});

export const multiRunPredictSchema = looseObject({
  input_tokens: numberish.nullish(),
  total_cost_krw: numberish.nullish(),
  priced_models: numberish.nullish(),
  note: z.string().nullish(),
  estimates: looseList({
    model: z.string().nullish(),
    cost_krw: numberish.nullish(),
    priced: z.boolean().nullish(),
    input_tokens: numberish.nullish(),
    output_tokens: numberish.nullish(),
  }).nullish(),
});

export const multiRunListSchema = looseObject({
  runs: looseList({
    id: z.string(),
    title: z.string().nullish(),
    created_by: z.string().nullish(),
    team: z.string().nullish(),
    prompt_preview: z.string().nullish(),
    model_count: numberish.nullish(),
    success: numberish.nullish(),
    failed: numberish.nullish(),
    created_at: z.string().nullish(),
  })
    .nullish()
    .transform((value) => value ?? []),
});

export const multiRunDetailSchema = looseObject({
  run: looseObject({
    id: z.string(),
    title: z.string().nullish(),
    created_by: z.string().nullish(),
    created_at: z.string().nullish(),
    model_count: numberish.nullish(),
    success: numberish.nullish(),
    failed: numberish.nullish(),
    prompt_preview: z.string().nullish(),
  }).nullish(),
  results: looseList({
    model: z.string(),
    provider: z.string().nullish(),
    status: z.string().nullish(),
    status_code: numberish.nullish(),
    latency_ms: numberish.nullish(),
    input_tokens: numberish.nullish(),
    output_tokens: numberish.nullish(),
    total_tokens: numberish.nullish(),
    cost_krw: numberish.nullish(),
    response_preview: z.string().nullish(),
    error: z.string().nullish(),
  })
    .nullish()
    .transform((value) => value ?? []),
  feedback: z.array(unknownRecord).nullish(),
  promotions: z.array(unknownRecord).nullish(),
  judgements: looseList({
    model: z.string().nullish(),
    method: z.string().nullish(),
    judge_model: z.string().nullish(),
    total_score: numberish.nullish(),
    verdict: z.string().nullish(),
    reason_summary: z.string().nullish(),
  }).nullish(),
});

export const multiRunJudgeSchema = looseObject({
  run_id: z.string().nullish(),
  method: z.string().nullish(),
  best_model: z.string().nullish(),
  note: z.string().nullish(),
  judgements: looseList({
    model: z.string().nullish(),
    method: z.string().nullish(),
    judge_model: z.string().nullish(),
    accuracy: numberish.nullish(),
    completeness: numberish.nullish(),
    format_score: numberish.nullish(),
    safety: numberish.nullish(),
    cost_efficiency: numberish.nullish(),
    total_score: numberish.nullish(),
    verdict: z.string().nullish(),
    reason_summary: z.string().nullish(),
  })
    .nullish()
    .transform((value) => value ?? []),
});

export const multiRunCodeVerifySchema = looseObject({
  run_id: z.string().nullish(),
  leaderboard: looseList({
    model: z.string().nullish(),
    risk: z.string().nullish(),
    block_count: numberish.nullish(),
    high: numberish.nullish(),
    medium: numberish.nullish(),
    score: numberish.nullish(),
  }).nullish(),
  note: z.string().nullish(),
});

export const multiRunFeedbackSchema = looseObject({
  status: z.string().nullish(),
  run_id: z.string().nullish(),
  model: z.string().nullish(),
});

export const multiRunPromoteSchema = looseObject({
  status: z.string().nullish(),
  note: z.string().nullish(),
  promotion: looseObject({
    id: z.string().nullish(),
    run_id: z.string().nullish(),
    selected_model: z.string().nullish(),
    task_type: z.string().nullish(),
    status: z.string().nullish(),
    created_by: z.string().nullish(),
  }).nullish(),
});

export const multiRunGoldenSchema = looseObject({
  status: z.string().nullish(),
  workflow_id: z.string().nullish(),
  workflow_name: z.string().nullish(),
  step_name: z.string().nullish(),
  step_count: numberish.nullish(),
  baseline_score: numberish.nullish(),
});

/** One structural block of a stored answer; `preview` is response text, so it stays on screen. */
const multiRunDiffBlockShape = {
  type: z.string().nullish(),
  preview: z.string().nullish(),
  key: z.string().nullish(),
} as const;

const multiRunDiffStatsSchema = looseObject({
  available: z.boolean().nullish(),
  paragraphs: numberish.nullish(),
  list_items: numberish.nullish(),
  code_blocks: numberish.nullish(),
  chars: numberish.nullish(),
  lines: numberish.nullish(),
  has_table: z.boolean().nullish(),
  has_code: z.boolean().nullish(),
});

export const multiRunDiffSchema = looseObject({
  run_id: z.string().nullish(),
  answered_models: numberish.nullish(),
  note: z.string().nullish(),
  common_blocks: looseList(multiRunDiffBlockShape)
    .nullish()
    .transform((value) => value ?? []),
  models: looseList({
    model: z.string().nullish(),
    blocks: looseList(multiRunDiffBlockShape).nullish(),
    stats: multiRunDiffStatsSchema.nullish(),
  })
    .nullish()
    .transform((value) => value ?? []),
  per_model: looseList({
    model: z.string().nullish(),
    available: z.boolean().nullish(),
    block_count: numberish.nullish(),
    missing: looseList(multiRunDiffBlockShape).nullish(),
    extra: looseList(multiRunDiffBlockShape).nullish(),
    stats: multiRunDiffStatsSchema.nullish(),
  })
    .nullish()
    .transform((value) => value ?? []),
});

export const multiRunLeaderboardSchema = looseObject({
  team: z.string().nullish(),
  days: numberish.nullish(),
  runs: numberish.nullish(),
  note: z.string().nullish(),
  leaderboard: looseList({
    model: z.string(),
    appearances: numberish.nullish(),
    avg_score: numberish.nullish(),
    pass_rate: numberish.nullish(),
    wins: numberish.nullish(),
  })
    .nullish()
    .transform((value) => value ?? []),
});

/* ── MCP routing probes ────────────────────────────────────────────────────── */

export const mcpRouteExplainSchema = looseObject({
  decision: z.string().nullish(),
  reason: z.string().nullish(),
  candidates: z.array(unknownRecord).nullish(),
});

export const mcpTestSchema = looseObject({
  status: z.string().nullish(),
  ok: z.boolean().nullish(),
  latency_ms: numberish.nullish(),
  error: z.string().nullish(),
});

/* ── model governance ──────────────────────────────────────────────────────── */

export const modelContractSchema = looseObject({
  id: z.string(),
  name: z.string(),
  task_type: z.string().nullish(),
  min_quality_score: numberish.nullish(),
  min_golden_pass_rate: numberish.nullish(),
  min_success_rate: numberish.nullish(),
  max_latency_ms: numberish.nullish(),
  max_avg_cost_krw: numberish.nullish(),
  enabled: z.boolean().nullish(),
  created_by: z.string().nullish(),
  updated_at: z.string().nullish(),
});

export const modelContractListSchema = looseObject({
  contracts: z
    .array(modelContractSchema)
    .nullish()
    .transform((value) => value ?? []),
});

export const modelContractRunSchema = looseObject({
  model: z.string().nullish(),
  window: z.string().nullish(),
  replaceable: z.boolean().nullish(),
  note: z.string().nullish(),
  have_metrics: z
    .looseObject({
      quality: z.boolean().nullish(),
      latency: z.boolean().nullish(),
      cost: z.boolean().nullish(),
    })
    .nullish(),
  results: looseList({
    contract_id: z.string().nullish(),
    contract_name: z.string().nullish(),
    task_type: z.string().nullish(),
    verdict: z.string().nullish(),
    replaceable: z.boolean().nullish(),
    checks: looseList({
      dimension: z.string().nullish(),
      threshold: z.unknown().nullish(),
      actual: z.unknown().nullish(),
      status: z.string().nullish(),
    }).nullish(),
  })
    .nullish()
    .transform((value) => value ?? []),
  failing_samples: looseList({
    fingerprint: z.string().nullish(),
    reason: z.string().nullish(),
  }).nullish(),
});

export const modelDeprecationSchema = looseObject({
  id: z.string(),
  model_glob: z.string(),
  replacement: z.string().nullish(),
  sunset_date: z.string().nullish(),
  message: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});

export const modelDeprecationListSchema = looseObject({
  deprecations: z
    .array(modelDeprecationSchema)
    .nullish()
    .transform((value) => value ?? []),
});

export const modelDeprecationSaveSchema = looseObject({ deprecation: modelDeprecationSchema.nullish() });

export const modelUsageTagWriteSchema = looseObject({
  model: z.string().nullish(),
  good_for: z.string().nullish(),
  avoid_for: z.string().nullish(),
  risk_note: z.string().nullish(),
  updated_at: z.string().nullish(),
});

/* ── provider administration ───────────────────────────────────────────────── */

export const providerSaveSchema = looseObject({
  provider: looseObject({
    name: z.string(),
    provider_ref: z.string().nullish(),
    base_url: z.string().nullish(),
    api_key_configured: z.boolean().nullish(),
    timeout_ms: numberish.nullish(),
    enabled: z.boolean().nullish(),
    model_patterns: z.string().nullish(),
    failover_group: z.string().nullish(),
    priority: numberish.nullish(),
  }).nullish(),
});

export const providerDeleteSchema = looseObject({ deleted: z.string().nullish() });

export const providerSLOSaveSchema = looseObject({
  slo: looseObject({
    provider: z.string().nullish(),
    provider_ref: z.string().nullish(),
    availability_target: numberish.nullish(),
    p95_latency_target_ms: numberish.nullish(),
    error_rate_target: numberish.nullish(),
    fallback_rate_target: numberish.nullish(),
    enabled: z.boolean().nullish(),
    note: z.string().nullish(),
  }).nullish(),
});

export const providerSLODeleteSchema = looseObject({
  provider: z.string().nullish(),
  provider_ref: z.string().nullish(),
  status: z.string().nullish(),
});

/* ── routing operations shown on the gateway health screen ─────────────────── */

export const breakerResetSchema = looseObject({
  status: z.string().nullish(),
  provider: z.string().nullish(),
  states: z.array(unknownRecord).nullish(),
});

export const balancerSchema = looseObject({
  mode: z.string().nullish(),
  multi_instance_safe: z.boolean().nullish(),
  sticky_sessions: z.boolean().nullish(),
  sticky_ttl: z.string().nullish(),
  active_sessions: numberish.nullish(),
  balance_index: numberish.nullish(),
  pools: looseList({
    pattern: z.string().nullish(),
    providers: z.array(z.string()).nullish(),
    size: numberish.nullish(),
    balanced: z.boolean().nullish(),
  }).nullish(),
});

export const balancerReleaseSchema = looseObject({
  status: z.string().nullish(),
  provider: z.string().nullish(),
  released_sessions: numberish.nullish(),
});

/* ── prompt lab ────────────────────────────────────────────────────────────── */

export const promptExperimentSchema = looseObject({
  id: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  team: z.string().nullish(),
  owner: z.string().nullish(),
  status: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});

export const promptExperimentListSchema = looseObject({
  experiments: z
    .array(promptExperimentSchema)
    .nullish()
    .transform((value) => value ?? []),
});

export const promptContractSchema = looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string().nullish(),
  schema_json: z.string().nullish(),
  strict: z.boolean().nullish(),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
});

export const promptContractListSchema = looseObject({
  contracts: z
    .array(promptContractSchema)
    .nullish()
    .transform((value) => value ?? []),
});

export const promptRubricSchema = looseObject({
  id: z.string(),
  name: z.string(),
  criteria_json: z.string().nullish(),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
});

export const promptRubricListSchema = looseObject({
  rubrics: z
    .array(promptRubricSchema)
    .nullish()
    .transform((value) => value ?? []),
});

export const promptTestCaseSchema = looseObject({
  id: z.string(),
  experiment_id: z.string().nullish(),
  name: z.string(),
  messages_hash: z.string().nullish(),
  rubric_id: z.string().nullish(),
  contract_id: z.string().nullish(),
  models_json: z.string().nullish(),
  created_by: z.string().nullish(),
  created_at: z.string().nullish(),
});

export const promptExperimentDetailSchema = looseObject({
  experiment: promptExperimentSchema.nullish(),
  test_cases: z
    .array(promptTestCaseSchema)
    .nullish()
    .transform((value) => value ?? []),
});

/** `PATCH /admin/prompt-lab/experiments/{id}` echoes only the new status. */
export const promptExperimentStatusSchema = looseObject({ status: z.string().nullish() });

const promptTestCaseRunHistoryShape = {
  id: z.string().nullish(),
  run_id: z.string().nullish(),
  best_model: z.string().nullish(),
  avg_score: numberish.nullish(),
  contract_pass: numberish.nullish(),
  model_count: numberish.nullish(),
  avg_cost_krw: numberish.nullish(),
  avg_latency_ms: numberish.nullish(),
  created_at: z.string().nullish(),
} as const;

/** `POST /admin/prompt-lab/test-cases/{id}/run` — scores only, never the answers. */
export const promptTestCaseRunSchema = looseObject({
  status: z.string().nullish(),
  run_id: z.string().nullish(),
  best_model: z.string().nullish(),
  avg_score: numberish.nullish(),
  contract_applied: z.boolean().nullish(),
  contract_pass: numberish.nullish(),
  model_count: numberish.nullish(),
  results: looseList({
    model: z.string().nullish(),
    score: numberish.nullish(),
    verdict: z.string().nullish(),
    contract_pass: z.boolean().nullish(),
    contract_errors: z.array(z.string()).nullish(),
    cost_krw: numberish.nullish(),
    latency_ms: numberish.nullish(),
    status: z.string().nullish(),
  })
    .nullish()
    .transform((value) => value ?? []),
  history: looseList(promptTestCaseRunHistoryShape)
    .nullish()
    .transform((value) => value ?? []),
});

export const promptTestCaseDetailSchema = looseObject({
  test_case: promptTestCaseSchema.nullish(),
  history: looseList({
    id: z.string().nullish(),
    run_id: z.string().nullish(),
    best_model: z.string().nullish(),
    avg_score: numberish.nullish(),
    contract_pass: numberish.nullish(),
    model_count: numberish.nullish(),
    avg_cost_krw: numberish.nullish(),
    avg_latency_ms: numberish.nullish(),
    created_at: z.string().nullish(),
  })
    .nullish()
    .transform((value) => value ?? []),
});

export const gatewayAcknowledgementSchema = acknowledgement;

export type ChatTestTarget = z.output<typeof chatTestTargetSchema>;
export type ChatTestTargets = z.output<typeof chatTestTargetsSchema>;
export type RoutingPreview = z.output<typeof routingPreviewSchema>;
export type CodeVerifyReport = z.output<typeof codeVerifyReportSchema>;
export type CodeVerifyStats = z.output<typeof codeVerifyStatsSchema>;
export type MultiRunResponse = z.output<typeof multiRunResponseSchema>;
export type MultiRunResult = z.output<typeof multiRunResultSchema>;
export type MultiRunPredict = z.output<typeof multiRunPredictSchema>;
export type MultiRunList = z.output<typeof multiRunListSchema>;
export type MultiRunDetail = z.output<typeof multiRunDetailSchema>;
export type MultiRunJudge = z.output<typeof multiRunJudgeSchema>;
export type MultiRunCodeVerify = z.output<typeof multiRunCodeVerifySchema>;
export type MultiRunPromote = z.output<typeof multiRunPromoteSchema>;
export type MultiRunGolden = z.output<typeof multiRunGoldenSchema>;
export type MultiRunDiff = z.output<typeof multiRunDiffSchema>;
export type PromptTestCaseRun = z.output<typeof promptTestCaseRunSchema>;
export type MultiRunLeaderboard = z.output<typeof multiRunLeaderboardSchema>;
export type ModelContract = z.output<typeof modelContractSchema>;
export type ModelContractRun = z.output<typeof modelContractRunSchema>;
export type ModelDeprecation = z.output<typeof modelDeprecationSchema>;
export type Balancer = z.output<typeof balancerSchema>;
export type PromptExperiment = z.output<typeof promptExperimentSchema>;
export type PromptContract = z.output<typeof promptContractSchema>;
export type PromptRubric = z.output<typeof promptRubricSchema>;
export type PromptTestCase = z.output<typeof promptTestCaseSchema>;
export type PromptExperimentDetail = z.output<typeof promptExperimentDetailSchema>;
