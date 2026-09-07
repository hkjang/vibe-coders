import { z } from "zod";

import { looseList, looseObject, numberish, orDefault, unknownRecord } from "@/shared/api/loose";

// Response contracts for the legacy observability APIs. The OpenAPI document
// declares these operations without a response schema, so the shapes below are
// transcribed from the Go handlers (internal/proxy/admin_*.go, internal/store/*.go)
// and only cover the fields the screens render.

const optionalText = orDefault(z.string(), "");
const count = orDefault(numberish, 0);

/** store.ScatterPoint (internal/store/types.go). */
export const scatterPointSchema = looseObject({
  request_id: optionalText,
  trace_id: optionalText,
  created_at: optionalText,
  ingested_at: optionalText,
  latency_ms: count,
  first_chunk_ms: count,
  status_code: count,
  provider: optionalText,
  model: optionalText,
  endpoint: optionalText,
  total_tokens: count,
  cost_krw: count,
  stream: orDefault(z.boolean(), false),
  tool_count: count,
  failover: orDefault(z.boolean(), false),
  complexity: count,
  risk_score: count,
  health_score: count,
  decision_reason: optionalText,
  policy_decision_count: count,
  policy_decision: optionalText,
  approval_count: count,
  approval_status: optionalText,
  secret_event_count: count,
  secret_action: optionalText,
});
export type ScatterPoint = z.output<typeof scatterPointSchema>;

/** store.ScatterModelGroup. */
export const scatterModelGroupSchema = looseObject({
  model: optionalText,
  count: count,
  error_rate: count,
  p50: count,
  p95: count,
  p99: count,
  avg_first_chunk_ms: count,
  total_tokens: count,
  total_cost_krw: count,
  avg_cost_krw: count,
  failover_count: count,
  governance_count: count,
  risk_p95: count,
  health_avg: count,
});
export type ScatterModelGroup = z.output<typeof scatterModelGroupSchema>;

const scatterCursorSchema = looseObject({
  ingested_at: optionalText,
  request_id: optionalText,
});

/** GET /admin/scatter (handleScatter, internal/proxy/admin_analytics.go). */
export const scatterResponseSchema = looseObject({
  points: orDefault(z.array(scatterPointSchema), []),
  groups: orDefault(z.array(scatterModelGroupSchema), []),
  truncated: orDefault(z.boolean(), false),
  since: optionalText,
  cursor: orDefault(scatterCursorSchema, { ingested_at: "", request_id: "" }),
  server_time: optionalText,
});
export type ScatterResponse = z.output<typeof scatterResponseSchema>;

/** GET /admin/xview/delta (handleXViewDelta). */
export const xviewDeltaResponseSchema = looseObject({
  points: orDefault(z.array(scatterPointSchema), []),
  cursor: orDefault(scatterCursorSchema, { ingested_at: "", request_id: "" }),
  has_more: orDefault(z.boolean(), false),
  server_time: optionalText,
});
export type XViewDeltaResponse = z.output<typeof xviewDeltaResponseSchema>;

/**
 * Coverage disclosure attached to every XView aggregate (withXViewCoverage).
 * `truncated` means the aggregate only saw `sample_size` rows, the oldest of
 * which is `covered_since` — the screens must show this, never hide it.
 */
const coverageShape = {
  truncated: orDefault(z.boolean(), false),
  sample_size: count,
  aggregate_limit: count,
  covered_since: optionalText,
};

/** GET /admin/xview/models. */
export const xviewModelsResponseSchema = looseObject({
  ...coverageShape,
  since: optionalText,
  top: count,
  models: orDefault(z.array(scatterModelGroupSchema), []),
});
export type XViewModelsResponse = z.output<typeof xviewModelsResponseSchema>;

export const xviewSeriesPointSchema = looseObject({
  ts: optionalText,
  count: count,
  error_rate: count,
  avg_latency_ms: count,
  cost_krw: count,
});
export type XViewSeriesPoint = z.output<typeof xviewSeriesPointSchema>;

/** GET /admin/xview/model-series. */
export const xviewModelSeriesResponseSchema = looseObject({
  ...coverageShape,
  since: optionalText,
  bucket: optionalText,
  series: orDefault(z.record(z.string(), z.array(xviewSeriesPointSchema)), {}),
});
export type XViewModelSeriesResponse = z.output<typeof xviewModelSeriesResponseSchema>;

export const xviewOutlierSchema = looseObject({
  request_id: optionalText,
  trace_id: optionalText,
  model: optionalText,
  latency_ms: count,
  tags: orDefault(z.array(z.string()), []),
});
export type XViewOutlier = z.output<typeof xviewOutlierSchema>;

/** GET /admin/xview/model-outliers. */
export const xviewModelOutliersResponseSchema = looseObject({
  ...coverageShape,
  since: optionalText,
  outliers: orDefault(z.array(xviewOutlierSchema), []),
});
export type XViewModelOutliersResponse = z.output<typeof xviewModelOutliersResponseSchema>;

/** store.SavedFilter. */
export const savedFilterSchema = looseObject({
  id: z.string(),
  name: optionalText,
  view: optionalText,
  params: optionalText,
  created_by: optionalText,
  created_at: optionalText,
});
export type SavedFilter = z.output<typeof savedFilterSchema>;

export const savedFilterListSchema = looseObject({
  filters: orDefault(z.array(savedFilterSchema), []),
});

export const savedFilterEnvelopeSchema = looseObject({ filter: savedFilterSchema });

export const savedFilterDeletedSchema = looseObject({
  id: optionalText,
  status: optionalText,
});

/** store.SessionSummary (internal/store/sessions.go). */
export const sessionSummarySchema = looseObject({
  session_id: optionalText,
  requests: count,
  first_seen: optionalText,
  last_seen: optionalText,
  models: count,
  api_keys: count,
  errors: count,
  total_tokens: count,
  cost_krw: count,
  last_message: optionalText,
});
export type SessionSummary = z.output<typeof sessionSummarySchema>;

/** GET /admin/sessions. */
export const sessionListResponseSchema = looseObject({
  days: count,
  sessions: orDefault(z.array(sessionSummarySchema), []),
  note: optionalText,
});
export type SessionListResponse = z.output<typeof sessionListResponseSchema>;

export const flightRecorderEventSchema = looseObject({
  request_id: optionalText,
  trace_id: optionalText,
  kind: optionalText,
  endpoint: optionalText,
  model: optionalText,
  provider: optionalText,
  status_code: count,
  is_error: orDefault(z.boolean(), false),
  latency_ms: count,
  total_tokens: count,
  cost_krw: count,
  tool_count: count,
  created_at: optionalText,
  last_message: optionalText,
  secret_events: orDefault(numberish, 0),
  policy_blocks: orDefault(numberish, 0),
  code_risk: optionalText,
});
export type FlightRecorderEvent = z.output<typeof flightRecorderEventSchema>;

/** GET /admin/sessions/{session_id}/flight-recorder. */
export const flightRecorderResponseSchema = looseObject({
  session_id: optionalText,
  events: orDefault(z.array(flightRecorderEventSchema), []),
  summary: orDefault(
    looseObject({
      verdict: optionalText,
      headline: optionalText,
      findings: orDefault(z.array(z.string()), []),
    }),
    { verdict: "", headline: "", findings: [] },
  ),
  rollup: orDefault(
    looseObject({
      requests: count,
      started_at: optionalText,
      ended_at: optionalText,
      models: orDefault(z.array(z.string()), []),
      providers: orDefault(z.array(z.string()), []),
      trace_ids: orDefault(z.array(z.string()), []),
      kinds: orDefault(z.record(z.string(), numberish), {}),
      total_tokens: count,
      total_cost: count,
      errors: count,
      tool_calls: count,
      risk: orDefault(
        looseObject({
          secret_requests: count,
          policy_block_requests: count,
          high_risk_code_requests: count,
        }),
        { secret_requests: 0, policy_block_requests: 0, high_risk_code_requests: 0 },
      ),
    }),
    {
      requests: 0,
      started_at: "",
      ended_at: "",
      models: [],
      providers: [],
      trace_ids: [],
      kinds: {},
      total_tokens: 0,
      total_cost: 0,
      errors: 0,
      tool_calls: 0,
      risk: { secret_requests: 0, policy_block_requests: 0, high_risk_code_requests: 0 },
    },
  ),
  note: optionalText,
});
export type FlightRecorderResponse = z.output<typeof flightRecorderResponseSchema>;

/** store.WaterfallSpan. */
export const waterfallSpanSchema = looseObject({
  seq: count,
  request_id: optionalText,
  trace_id: optionalText,
  model: optionalText,
  requested_model: optionalText,
  provider: optionalText,
  endpoint: optionalText,
  status_code: count,
  start_offset_ms: count,
  ttfb_ms: count,
  total_ms: count,
  gap_before_ms: count,
  category: optionalText,
  complexity: count,
  total_tokens: count,
  cost_krw: count,
  tool_calls: count,
  tool_errors: count,
  fallback_from: optionalText,
  slow: orDefault(z.boolean(), false),
  created_at: optionalText,
});
export type WaterfallSpan = z.output<typeof waterfallSpanSchema>;

/** GET /admin/waterfall (store.WaterfallTrace). */
export const waterfallResponseSchema = looseObject({
  session_id: optionalText,
  requests: count,
  wall_ms: count,
  busy_ms: count,
  idle_ms: count,
  busy_ratio: count,
  total_cost_krw: count,
  total_tokens: count,
  tool_calls: count,
  wait_ms: count,
  stream_ms: count,
  slow_ms: count,
  slow_count: count,
  bottleneck: orDefault(
    looseObject({
      slowest_seq: count,
      slowest_ms: count,
      slowest_pct: count,
      longest_gap_seq: count,
      longest_gap_ms: count,
      longest_gap_pct: count,
    }),
    {
      slowest_seq: 0,
      slowest_ms: 0,
      slowest_pct: 0,
      longest_gap_seq: 0,
      longest_gap_ms: 0,
      longest_gap_pct: 0,
    },
  ),
  categories: orDefault(z.record(z.string(), numberish), {}),
  started_at: optionalText,
  truncated: orDefault(z.boolean(), false),
  spans: orDefault(z.array(waterfallSpanSchema), []),
});
export type WaterfallResponse = z.output<typeof waterfallResponseSchema>;

/** GET /admin/flow-map. */
export const flowMapResponseSchema = looseObject({
  request_id: optionalText,
  summary: orDefault(
    looseObject({
      model: optionalText,
      provider: optionalText,
      status_code: count,
      latency_ms: count,
      trace_id: optionalText,
      created_at: optionalText,
    }),
    { model: "", provider: "", status_code: 0, latency_ms: 0, trace_id: "", created_at: "" },
  ),
  stages: orDefault(
    z.array(
      looseObject({
        stage: optionalText,
        status: optionalText,
        latency_ms: count,
        decision: optionalText,
        reason: optionalText,
        linked_artifacts: orDefault(unknownRecord, {}),
      }),
    ),
    [],
  ),
  note: optionalText,
});
export type FlowMapResponse = z.output<typeof flowMapResponseSchema>;

/** store.RecentRequest, limited to the fields the LLM screen renders. */
export const llmTraceSchema = looseObject({
  id: optionalText,
  trace_id: optionalText,
  api_key_id: optionalText,
  model: optionalText,
  provider: optionalText,
  endpoint: optionalText,
  status_code: count,
  latency_ms: count,
  first_chunk_ms: count,
  session_id: optionalText,
  prompt_name: optionalText,
  prompt_version: optionalText,
  tool_count: count,
  error: optionalText,
  total_tokens: count,
  estimated_cost: count,
  finish_reason: optionalText,
  created_at: optionalText,
});
export type LLMTrace = z.output<typeof llmTraceSchema>;

/** store.LLMSessionSummary. */
export const llmSessionSchema = looseObject({
  session_id: optionalText,
  requests: count,
  tokens: count,
  cost_krw: count,
  errors: count,
  evaluation_failures: count,
  first_seen: optionalText,
  last_seen: optionalText,
  last_message: optionalText,
});
export type LLMSession = z.output<typeof llmSessionSchema>;

export const llmSessionsResponseSchema = looseObject({
  sessions: orDefault(z.array(llmSessionSchema), []),
  page: orDefault(looseObject({ limit: count, offset: count, has_more: orDefault(z.boolean(), false) }), {
    limit: 0,
    offset: 0,
    has_more: false,
  }),
});
export type LLMSessionsResponse = z.output<typeof llmSessionsResponseSchema>;

/** store.SessionTimeline (GET /admin/llm/session). */
export const llmSessionTimelineSchema = looseObject({
  session_id: optionalText,
  requests: count,
  total_cost_krw: count,
  total_tokens: count,
  tool_calls: count,
  duration_seconds: count,
  points: orDefault(
    z.array(
      looseObject({
        request_id: optionalText,
        trace_id: optionalText,
        model: optionalText,
        provider: optionalText,
        prompt_name: optionalText,
        last_message: optionalText,
        status_code: count,
        latency_ms: count,
        first_chunk_ms: count,
        total_tokens: count,
        cost_krw: count,
        tool_calls: count,
        tool_errors: count,
        eval_failures: count,
        created_at: optionalText,
        cumulative_cost_krw: count,
        cumulative_tokens: count,
      }),
    ),
    [],
  ),
});
export type LLMSessionTimeline = z.output<typeof llmSessionTimelineSchema>;

/** store.LLMEvaluation. */
export const llmEvaluationSchema = looseObject({
  id: optionalText,
  request_id: optionalText,
  trace_id: optionalText,
  name: optionalText,
  category: optionalText,
  evaluator: optionalText,
  score: count,
  label: optionalText,
  passed: orDefault(z.boolean(), false),
  reason: optionalText,
  created_at: optionalText,
});
export type LLMEvaluation = z.output<typeof llmEvaluationSchema>;

export const llmEvaluationsResponseSchema = looseObject({
  summary: orDefault(
    looseList({
      name: optionalText,
      category: optionalText,
      total: count,
      passed: count,
      failed: count,
      average_score: count,
    }),
    [],
  ),
  evaluations: orDefault(z.array(llmEvaluationSchema), []),
});
export type LLMEvaluationsResponse = z.output<typeof llmEvaluationsResponseSchema>;

/** store.LLMFeedback. */
export const llmFeedbackSchema = looseObject({
  id: optionalText,
  request_id: optionalText,
  trace_id: optionalText,
  rating: count,
  label: optionalText,
  comment: optionalText,
  source: optionalText,
  created_by: optionalText,
  created_at: optionalText,
});
export type LLMFeedbackEntry = z.output<typeof llmFeedbackSchema>;

export const llmFeedbackResponseSchema = looseObject({
  summary: orDefault(
    looseObject({
      total: count,
      positive: count,
      negative: count,
      neutral: count,
      average_rating: count,
    }),
    { total: 0, positive: 0, negative: 0, neutral: 0, average_rating: 0 },
  ),
  feedback: orDefault(z.array(llmFeedbackSchema), []),
  labels: orDefault(
    looseList({
      label: optionalText,
      total: count,
      positive: count,
      negative: count,
      neutral: count,
      average_rating: count,
    }),
    [],
  ),
  prompts: orDefault(
    looseList({
      prompt_name: optionalText,
      prompt_version: optionalText,
      total: count,
      positive: count,
      negative: count,
    }),
    [],
  ),
  alignment: orDefault(
    looseObject({
      total: count,
      aligned: count,
      misaligned: count,
      alignment_rate: count,
      human_negative_count: count,
    }),
    { total: 0, aligned: 0, misaligned: 0, alignment_rate: 0, human_negative_count: 0 },
  ),
  alignment_prompts: orDefault(
    looseList({
      prompt_name: optionalText,
      prompt_version: optionalText,
      total: count,
      aligned: count,
      misaligned: count,
      alignment_rate: count,
      human_negative: count,
      eval_failure_rate: count,
      last_seen: optionalText,
    }),
    [],
  ),
});
export type LLMFeedbackResponse = z.output<typeof llmFeedbackResponseSchema>;

export const llmFeedbackCreatedSchema = looseObject({ feedback: llmFeedbackSchema });

/** store.LLMPromptSummary. */
export const llmPromptSchema = looseObject({
  prompt_name: optionalText,
  prompt_version: optionalText,
  calls: count,
  tokens: count,
  cost_krw: count,
  average_latency_ms: count,
  errors: count,
  eval_failures: count,
  first_seen: optionalText,
  last_seen: optionalText,
});
export type LLMPrompt = z.output<typeof llmPromptSchema>;

export const llmPromptsResponseSchema = looseObject({
  prompts: orDefault(z.array(llmPromptSchema), []),
});

/** store.LLMPromptComparison (GET /admin/llm/prompts/compare). */
export const llmPromptCompareResponseSchema = looseObject({
  prompt_name: optionalText,
  candidate: llmPromptSchema,
  baseline: llmPromptSchema.nullish(),
  baseline_reason: optionalText,
  available_versions: orDefault(z.array(z.string()), []),
  candidate_error_rate: count,
  baseline_error_rate: count,
  candidate_eval_failure_rate: count,
  baseline_eval_failure_rate: count,
  delta: orDefault(
    looseObject({
      calls: count,
      tokens: count,
      cost_krw: count,
      average_latency_ms: count,
      error_rate: count,
      eval_failure_rate: count,
    }),
    { calls: 0, tokens: 0, cost_krw: 0, average_latency_ms: 0, error_rate: 0, eval_failure_rate: 0 },
  ),
});
export type LLMPromptCompareResponse = z.output<typeof llmPromptCompareResponseSchema>;

/** store.LLMPatternSummary. */
export const llmPatternsResponseSchema = looseObject({
  patterns: orDefault(
    looseList({
      pattern: optionalText,
      language: optionalText,
      requests: count,
      tokens: count,
      cost_krw: count,
      errors: count,
      average_latency_ms: count,
      sample: optionalText,
    }),
    [],
  ),
});
export type LLMPatternsResponse = z.output<typeof llmPatternsResponseSchema>;

/** store.LLMInsight. */
export const llmInsightSchema = looseObject({
  id: optionalText,
  severity: optionalText,
  kind: optionalText,
  title: optionalText,
  detail: optionalText,
  scope: optionalText,
  scope_value: optionalText,
  scope_detail: optionalText,
  count: count,
  metric_value: count,
  recommendation: optionalText,
  last_seen: optionalText,
});
export type LLMInsight = z.output<typeof llmInsightSchema>;

export const llmInsightsResponseSchema = looseObject({
  window: optionalText,
  since: optionalText,
  insights: orDefault(z.array(llmInsightSchema), []),
});

/** store.LLMTimeseriesPoint. */
export const llmTimeseriesResponseSchema = looseObject({
  window: optionalText,
  bucket: optionalText,
  since: optionalText,
  points: orDefault(
    looseList({
      date: optionalText,
      bucket: optionalText,
      requests: count,
      tokens: count,
      cost_krw: count,
      errors: count,
      average_first_chunk_ms: count,
      evaluation_failures: count,
      feedback_total: count,
      negative_feedback: count,
      alignment_samples: count,
      alignment_rate: count,
    }),
    [],
  ),
});
export type LLMTimeseriesResponse = z.output<typeof llmTimeseriesResponseSchema>;

/** store.RequestDetail, restricted to the safe metadata the LLM detail renders. */
export const llmTraceDetailSchema = looseObject({
  request: llmTraceSchema,
  spans: orDefault(
    looseList({
      id: optionalText,
      trace_id: optionalText,
      request_id: optionalText,
      parent_id: optionalText,
      name: optionalText,
      kind: optionalText,
      status: optionalText,
      error: optionalText,
      latency_ms: count,
      first_chunk_ms: count,
      total_tokens: count,
      estimated_cost: count,
      tool_count: count,
      created_at: optionalText,
    }),
    [],
  ),
  evaluations: orDefault(z.array(llmEvaluationSchema), []),
  feedback: orDefault(z.array(llmFeedbackSchema), []),
  tools: orDefault(
    looseList({
      id: optionalText,
      request_id: optionalText,
      server_label: optionalText,
      tool_name: optionalText,
      source: optionalText,
      is_mcp: orDefault(z.boolean(), false),
      is_error: orDefault(z.boolean(), false),
      arg_sensitive: orDefault(z.boolean(), false),
      arg_hash: optionalText,
      created_at: optionalText,
    }),
    [],
  ),
  code_verify: looseObject({
    risk: optionalText,
    has_code: orDefault(z.boolean(), false),
    block_count: count,
    languages: optionalText,
    high_count: count,
    medium_count: count,
    syntax_count: count,
    secret_count: count,
    testable_count: count,
    created_at: optionalText,
  }).nullish(),
});
export type LLMTraceDetail = z.output<typeof llmTraceDetailSchema>;

/** GET /admin/pods (store.PodStatus). */
export const podsResponseSchema = looseObject({
  pods: orDefault(
    looseList({
      hostname: optionalText,
      build_version: optionalText,
      applied_token: optionalText,
      current_token: optionalText,
      reload_interval_s: count,
      last_seen: optionalText,
      stale: orDefault(z.boolean(), false),
      up_to_date: orDefault(z.boolean(), false),
    }),
    [],
  ),
  summary: orDefault(looseObject({ total: count, live: count, stale: count, converged: count }), {
    total: 0,
    live: 0,
    stale: 0,
    converged: 0,
  }),
  stale_s: count,
  note: optionalText,
});
export type PodsResponse = z.output<typeof podsResponseSchema>;

/** POST /admin/journey-probe. */
export const journeyProbeResponseSchema = looseObject({
  results: orDefault(
    looseList({
      client: optionalText,
      overall: optionalText,
      checks: orDefault(
        looseList({
          name: optionalText,
          status: optionalText,
          detail: optionalText,
          fix: optionalText,
        }),
        [],
      ),
    }),
    [],
  ),
  summary: orDefault(looseObject({ clients: count, passing: count, failing: count }), {
    clients: 0,
    passing: 0,
    failing: 0,
  }),
  note: optionalText,
});
export type JourneyProbeResponse = z.output<typeof journeyProbeResponseSchema>;

/** GET /admin/capabilities (internal/proxy/capabilities.go). */
export const capabilitiesResponseSchema = looseObject({
  capabilities: orDefault(
    looseList({
      key: optionalText,
      name: optionalText,
      description: optionalText,
      group: optionalText,
      apis: orDefault(z.array(z.string()), []),
      ui_tabs: orDefault(z.array(z.string()), []),
      scopes: orDefault(z.array(z.string()), []),
      setting_keys: orDefault(z.array(z.string()), []),
      tables: orDefault(z.array(z.string()), []),
      workers: orDefault(z.array(z.string()), []),
      docs: orDefault(z.array(z.string()), []),
    }),
    [],
  ),
  count: count,
  groups: orDefault(z.record(z.string(), numberish), {}),
  note: optionalText,
});
export type CapabilitiesResponse = z.output<typeof capabilitiesResponseSchema>;

// ---------- request inspection (admin_explain.go, admin_collab.go, admin_users.go,
// admin_debug.go). These payloads can carry upstream error text and model-written
// prose, so the screen keeps them behind an explicit disclosure.

const flag = orDefault(z.boolean(), false);

/**
 * A nested explain section that may be missing or null. Every field inside already
 * has its own fallback, so an absent section parses as that all-fallback shape.
 */
function sectionOrEmpty<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.preprocess((value) => value ?? {}, looseObject(shape));
}

/** GET /admin/requests/{id}/explain (internal/proxy/admin_explain.go). */
export const requestExplainSchema = looseObject({
  request_id: optionalText,
  trace_id: optionalText,
  created_at: optionalText,
  routing: sectionOrEmpty({
    chosen_provider: optionalText,
    chosen_model: optionalText,
    requested_model: optionalText,
    model_changed: flag,
    reason: optionalText,
    reason_text: optionalText,
    detail: optionalText,
    complexity: count,
    tier: optionalText,
    risk_score: count,
    risk_tier: optionalText,
    risk_categories: orDefault(z.array(z.string()), []),
    health_score: count,
    decision_reason: optionalText,
    fallback_path: orDefault(z.array(z.string()), []),
    endpoint: optionalText,
  }),
  fallback: sectionOrEmpty({
    occurred: flag,
    from_provider: optionalText,
    to_provider: optionalText,
    reason: optionalText,
    error: optionalText,
  }),
  cache: sectionOrEmpty({
    hit: flag,
    cached_tokens: count,
    savings_krw: count,
    cached_savings_krw: count,
  }),
  safety: sectionOrEmpty({
    blocked: flag,
    masking: optionalText,
    finding_count: count,
    findings: orDefault(
      looseList({
        name: optionalText,
        label: optionalText,
        reason: optionalText,
        category: optionalText,
      }),
      [],
    ),
  }),
  governance: sectionOrEmpty({
    secret_event_count: count,
    secret_actions: orDefault(z.record(z.string(), numberish), {}),
    approval_count: count,
    approval_status: optionalText,
    anomaly_event_count: count,
    policy_decision_count: count,
    policy_decision_total: count,
  }),
  text2sql: sectionOrEmpty({
    span_count: count,
    status: optionalText,
    total_latency_ms: count,
    total_cost_krw: count,
  }),
  cost: sectionOrEmpty({
    actual_krw: count,
    currency: optionalText,
    token_source: optionalText,
    prompt_tokens: count,
    completion_tokens: count,
    cached_tokens: count,
    reasoning_tokens: count,
    total_tokens: count,
    list_krw: count,
    savings_krw: count,
    priced: flag,
  }),
  session: sectionOrEmpty({ session_id: optionalText, stream: flag }),
});
export type RequestExplain = z.output<typeof requestExplainSchema>;

/** store.RequestNote — GET/POST/PUT /admin/requests/{id}/note. */
export const requestNoteSchema = looseObject({
  request_id: optionalText,
  tags: orDefault(z.array(z.string()), []),
  note: optionalText,
  created_by: optionalText,
  updated_at: optionalText,
});
export type RequestNote = z.output<typeof requestNoteSchema>;

/** DELETE /admin/requests/{id}/note answers `{id, status:"deleted"}`. */
export const requestNoteDeletedSchema = looseObject({ id: optionalText, status: optionalText });

/** POST /admin/requests/{id}/analyze answers `{analysis}` written by a model. */
export const requestAnalysisSchema = looseObject({ analysis: optionalText });
export type RequestAnalysis = z.output<typeof requestAnalysisSchema>;

/**
 * POST /admin/requests/{id}/replay streams the upstream answer straight back, so the
 * body is the provider's JSON object — or, for a streamed call, `text/event-stream`
 * captured as plain text (`handleRequestReplay`).
 */
export const requestReplaySchema = z.union([z.string(), unknownRecord]);
export type RequestReplay = z.output<typeof requestReplaySchema>;
