// routing domain endpoints. Declare every server call this domain's screens make
// here with `operation()` from "@/shared/api/endpoint-factory" and a zod schema
// (see "@/shared/api/loose" for legacy responses without a documented shape).
import { z } from "zod";

import type {
  DeleteAdminRoutingRulesIdData,
  GetAdminCostData,
  GetAdminRoutingBalancerData,
  GetAdminRoutingDecisionsData,
  GetAdminRoutingDecisionsIdData,
  GetAdminRoutingDomainDecisionsData,
  GetAdminRoutingDomainExamplesData,
  GetAdminRoutingDomainReviewData,
  GetAdminRoutingHealthData,
  GetAdminRoutingLearningData,
  GetAdminRoutingPatternConflictsData,
  GetAdminRoutingRulesData,
  PatchAdminRoutingRulesIdData,
  PostAdminCostPredictData,
  PostAdminRoutingBalancerData,
  PostAdminRoutingBreakerResetData,
  PostAdminRoutingDomainReviewIdData,
  PostAdminRoutingFailoverDrillData,
  PostAdminRoutingPreviewData,
  PostAdminRoutingRulesData,
} from "@/shared/api/generated";
import { operation, pathWithParams, type WithBody, type WithQuery } from "@/shared/api/endpoint-factory";
import { looseList, looseObject, numberish, orDefault, unknownRecord } from "@/shared/api/loose";

const text = orDefault(z.string(), "");
const count = orDefault(numberish, 0);
const flag = orDefault(z.boolean(), false);
const strings = orDefault(z.array(z.string()), []);

/** A legacy list that may arrive as `null` when the store has no rows. */
function list<Shape extends z.ZodRawShape>(shape: Shape) {
  return orDefault(looseList(shape), []);
}

// ---------------------------------------------------------------- routing rules

/** `store.RoutingRule` (internal/store/types.go). */
const routingRuleShape = {
  id: text,
  enabled: flag,
  priority: count,
  match_pattern: text,
  min_complexity: count,
  max_complexity: count,
  target_model: text,
  target_provider: text,
  note: text,
  created_at: text,
} as const;

const routingRuleListSchema = looseObject({ rules: list(routingRuleShape) });
const routingRuleWriteSchema = looseObject({ rule: looseObject(routingRuleShape).optional() });
const deletedSchema = looseObject({ id: text, status: text });

/**
 * `PATCH /admin/routing-rules/{id}` — a partial edit. Absent fields keep their
 * stored value, and the server validates the merged rule, so moving one
 * complexity bound past the other is rejected rather than stored.
 */
export interface RoutingRuleToggleInput {
  enabled?: boolean;
  priority?: number;
  match_pattern?: string;
  min_complexity?: number;
  max_complexity?: number;
  target_model?: string;
  target_provider?: string;
  note?: string;
}

export interface RoutingRuleInput {
  match_pattern: string;
  min_complexity: number;
  max_complexity: number;
  target_model: string;
  target_provider: string;
  priority: number;
  enabled: boolean;
  note: string;
}

// --------------------------------------------------------------- provider health

const providerHealthScoreShape = {
  provider: text,
  provider_ref: text,
  score: count,
  requests: count,
  average_latency_ms: count,
  p95_latency_ms: count,
  timeouts: count,
  rate_429: count,
  rate_5xx: count,
  fallbacks: count,
  fallback_rate: count,
} as const;

const breakerStateShape = {
  provider: text,
  provider_ref: text,
  phase: text,
  failures: count,
  opens: count,
  last_reason: text,
  last_failure_at: text,
  opened_at: text,
  retry_in_seconds: count,
} as const;

const routingHealthSchema = looseObject({
  since: text,
  until: text,
  threshold: count,
  providers: list(providerHealthScoreShape),
  ranking: list({ rank: count, ...providerHealthScoreShape }),
  degraded: list(providerHealthScoreShape),
  alerts: list({ provider: text, provider_ref: text, code: text, severity: text, message: text }),
  trend: list({ since: text, until: text, providers: list(providerHealthScoreShape) }),
  breakers: looseObject({
    enabled: flag,
    threshold: count,
    cooldown_seconds: count,
    states: list(breakerStateShape),
    shared: flag,
    instance_id: text,
  }).optional(),
});

const breakerResetSchema = looseObject({
  status: text,
  provider: text,
  states: list(breakerStateShape),
});

// -------------------------------------------------------------------- balancer

const balancerSchema = looseObject({
  mode: text,
  multi_instance_safe: flag,
  sticky_sessions: flag,
  sticky_ttl: text,
  active_sessions: count,
  window_since: text,
  model: text,
  pools: list({ pattern: text, providers: strings, size: count, balanced: flag }),
  intent: list({ provider: text, picks: count, share: count, sessions: count }),
  actual: list({
    provider: text,
    requests: count,
    failovers: count,
    errors: count,
    avg_latency_ms: count,
  }),
  balance_index: count,
});

const balancerReleaseSchema = looseObject({
  status: text,
  provider: text,
  released_sessions: count,
});

// ------------------------------------------------------- failover drill / patterns

const failoverDrillSchema = looseObject({
  model: text,
  candidates: strings,
  failed_input: strings,
  health_demoted: strings,
  steps: list({ provider: text, outcome: text, detail: text }),
  served_by: text,
  outcome: text,
  advice: text,
  breaker_enabled: flag,
});

const patternConflictSchema = looseObject({
  generated_at: text,
  focus_provider: text,
  summary: looseObject({
    provider_count: count,
    enabled_provider_count: count,
    pattern_count: count,
    conflict_count: count,
    high_conflict_count: count,
    medium_conflict_count: count,
    affected_provider_count: count,
    redundant_pattern_count: count,
    focus_conflict_count: count,
    failover_ready_provider_count: count,
    failover_uncovered_provider_count: count,
  }).optional(),
  conflicts: list({
    id: text,
    type: text,
    severity: text,
    candidates: list({ provider: text, pattern: text }),
    witness_model: text,
    selected_provider: text,
    selected_pattern: text,
    decision_reason: text,
  }),
  redundancies: list({ provider: text, pattern: text, reason: text }),
  coverage: list({
    provider: text,
    patterns: strings,
    failover_group: text,
    failover_peers: strings,
    failover_ready: flag,
    peer_source: text,
  }),
  resolution_policy: looseObject({ mode: text, order: strings, description: text }).optional(),
  simulation: looseObject({
    model: text,
    matches: list({ provider: text, patterns: strings }),
    selected_provider: text,
    selected_pattern: text,
    route_reason: text,
    ambiguous: flag,
    failover_candidates: strings,
    failover_available: flag,
    failover_blocked_reason: text,
  })
    .nullish()
    .optional(),
  default_provider: text,
  default_provider_has_patterns: flag,
});

// --------------------------------------------------------------- routing preview

const complexitySchema = looseObject({ score: count, tier: text }).optional();
const riskSchema = looseObject({ score: count, tier: text, categories: strings }).optional();

const routingPreviewSchema = looseObject({
  requested_model: text,
  selected_model: text,
  selected_provider: text,
  policy_api_key_id: text,
  complexity: complexitySchema,
  risk: riskSchema,
  health_score: count,
  fallback_plan: strings,
  route_reason: text,
  decision_reason: text,
  would_rewrite: flag,
});

// -------------------------------------------------------------- routing decisions

const routingDecisionShape = {
  id: text,
  request_id: text,
  trace_id: text,
  requested_model: text,
  selected_model: text,
  selected_provider: text,
  complexity: complexitySchema,
  risk: riskSchema,
  health_score: count,
  fallback_path: strings,
  decision_reason: text,
  created_at: text,
} as const;

const routingDecisionListSchema = looseObject({ decisions: list(routingDecisionShape) });
const routingDecisionSchema = looseObject({ decision: looseObject(routingDecisionShape).optional() });

// ---------------------------------------------------------------- learning loop

const routingLearningSchema = looseObject({
  since: text,
  min_samples: count,
  cells: list({
    task_type: text,
    bucket: text,
    model: text,
    requests: count,
    successes: count,
    success_rate: count,
    fallback_rate: count,
    avg_cost_krw: count,
    avg_latency_ms: count,
    thumbs_up: count,
    thumbs_down: count,
  }),
  recommendations: list({
    task_type: text,
    bucket: text,
    recommended_model: text,
    success_rate: count,
    avg_cost_krw: count,
    samples: count,
    top_model: text,
    top_success_rate: count,
    differs: flag,
    confident: flag,
    rationale: text,
  }),
});

const domainDecisionsSchema = looseObject({
  decisions: list({
    id: text,
    request_id: text,
    user_id: text,
    team_id: text,
    route: text,
    confidence: count,
    tool_names: strings,
    evidence_score: count,
    evidence_count: count,
    fallback_used: flag,
    blocked_by_governance: flag,
    reason: text,
    created_at: text,
  }),
  signals: orDefault(unknownRecord, {}),
});

const domainExamplesSchema = looseObject({
  examples: list({
    id: text,
    route: text,
    source: text,
    confidence: count,
    approved: flag,
    auto_promoted: flag,
    created_at: text,
  }),
});

const domainReviewSchema = looseObject({
  items: list({
    id: text,
    decision_id: text,
    suggested_route: text,
    current_route: text,
    reason: text,
    status: text,
    created_at: text,
    reviewed_at: text,
  }),
});

const domainReviewActionSchema = looseObject({ id: text, status: text });

// ---------------------------------------------------------- cost guard / predict

const costGuardSchema = looseObject({ enabled: flag, threshold_krw: count });

const costEstimateSchema = looseObject({
  model: text,
  input_tokens: count,
  output_tokens: count,
  cost_krw: count,
  latency_ms: count,
  priced: flag,
  basis: text,
});

// ----------------------------------------------------------------- query schemas

const healthQuerySchema = z
  .object({ window: z.string().optional(), threshold: z.number().int().min(0).max(100).optional() })
  .strict();
const balancerQuerySchema = z
  .object({ window: z.string().optional(), model: z.string().optional() })
  .strict();
const limitQuerySchema = z.object({ limit: z.number().int().min(1).max(200).optional() }).strict();
const learningQuerySchema = z
  .object({ window: z.string().optional(), min_samples: z.number().int().min(1).optional() })
  .strict();
const domainQuerySchema = z
  .object({
    route: z.string().optional(),
    window: z.string().optional(),
    status: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const patternQuerySchema = z.object({ model: z.string().optional() }).strict();

export type RoutingHealthAppQuery = z.input<typeof healthQuerySchema>;
export type RoutingBalancerQuery = z.input<typeof balancerQuerySchema>;
export type RoutingLearningQuery = z.input<typeof learningQuerySchema>;
export type RoutingDomainQuery = z.input<typeof domainQuerySchema>;

export const routingEndpoints = {
  rules: {
    list: operation<GetAdminRoutingRulesData, unknown>()(
      "GET",
      "/admin/routing-rules",
      routingRuleListSchema,
    ),
    create: operation<WithBody<PostAdminRoutingRulesData, RoutingRuleInput>, unknown>()(
      "POST",
      "/admin/routing-rules",
      routingRuleWriteSchema,
    ),
    update: operation<WithBody<PatchAdminRoutingRulesIdData, RoutingRuleToggleInput>, unknown>()(
      "PATCH",
      "/admin/routing-rules/{id}",
      routingRuleWriteSchema,
    ),
    remove: operation<DeleteAdminRoutingRulesIdData, unknown>()(
      "DELETE",
      "/admin/routing-rules/{id}",
      deletedSchema,
    ),
  },
  health: operation<WithQuery<GetAdminRoutingHealthData, RoutingHealthAppQuery>, unknown>()(
    "GET",
    "/admin/routing/health",
    routingHealthSchema,
    healthQuerySchema,
  ),
  breakerReset: operation<WithBody<PostAdminRoutingBreakerResetData, { provider: string }>, unknown>()(
    "POST",
    "/admin/routing/breaker-reset",
    breakerResetSchema,
  ),
  balancer: {
    read: operation<WithQuery<GetAdminRoutingBalancerData, RoutingBalancerQuery>, unknown>()(
      "GET",
      "/admin/routing/balancer",
      balancerSchema,
      balancerQuerySchema,
    ),
    release: operation<WithBody<PostAdminRoutingBalancerData, { provider: string }>, unknown>()(
      "POST",
      "/admin/routing/balancer",
      balancerReleaseSchema,
    ),
  },
  failoverDrill: operation<
    WithBody<PostAdminRoutingFailoverDrillData, { model: string; fail: readonly string[] }>,
    unknown
  >()("POST", "/admin/routing/failover-drill", failoverDrillSchema),
  patternConflicts: operation<WithQuery<GetAdminRoutingPatternConflictsData, { model?: string }>, unknown>()(
    "GET",
    "/admin/routing/pattern-conflicts",
    patternConflictSchema,
    patternQuerySchema,
  ),
  preview: operation<WithBody<PostAdminRoutingPreviewData, Record<string, unknown>>, unknown>()(
    "POST",
    "/admin/routing/preview",
    routingPreviewSchema,
  ),
  decisions: {
    list: operation<WithQuery<GetAdminRoutingDecisionsData, { limit?: number }>, unknown>()(
      "GET",
      "/admin/routing/decisions",
      routingDecisionListSchema,
      limitQuerySchema,
    ),
    detail: operation<GetAdminRoutingDecisionsIdData, unknown>()(
      "GET",
      "/admin/routing/decisions/{id}",
      routingDecisionSchema,
    ),
  },
  learning: operation<WithQuery<GetAdminRoutingLearningData, RoutingLearningQuery>, unknown>()(
    "GET",
    "/admin/routing/learning",
    routingLearningSchema,
    learningQuerySchema,
  ),
  domain: {
    decisions: operation<WithQuery<GetAdminRoutingDomainDecisionsData, RoutingDomainQuery>, unknown>()(
      "GET",
      "/admin/routing/domain-decisions",
      domainDecisionsSchema,
      domainQuerySchema,
    ),
    examples: operation<WithQuery<GetAdminRoutingDomainExamplesData, RoutingDomainQuery>, unknown>()(
      "GET",
      "/admin/routing/domain-examples",
      domainExamplesSchema,
      domainQuerySchema,
    ),
    review: operation<WithQuery<GetAdminRoutingDomainReviewData, RoutingDomainQuery>, unknown>()(
      "GET",
      "/admin/routing/domain-review",
      domainReviewSchema,
      domainQuerySchema,
    ),
    // The server routes on `<id>/approve|reject` beneath this path, so the action
    // travels inside the documented `{id}` parameter.
    reviewAction: operation<PostAdminRoutingDomainReviewIdData, unknown>()(
      "POST",
      "/admin/routing/domain-review/{id}",
      domainReviewActionSchema,
    ),
  },
  costGuard: operation<GetAdminCostData, unknown>()("GET", "/admin/cost", costGuardSchema),
  costPredict: operation<
    WithBody<PostAdminCostPredictData, { model: string; input_tokens: number; max_tokens: number }>,
    unknown
  >()("POST", "/admin/cost/predict", costEstimateSchema),
} as const;

// Plain `{id}` binding uses the shared `withPathParams`. This helper stays because the
// action is not a parameter of its own: the server routes on `<id>/approve|reject`.
export function domainReviewActionEndpoint(
  id: string,
  action: "approve" | "reject",
): typeof routingEndpoints.domain.reviewAction {
  const endpoint = routingEndpoints.domain.reviewAction;
  return { ...endpoint, path: pathWithParams(endpoint.path, { id: `${id}/${action}` }) };
}

export type RoutingRule = z.output<typeof routingRuleListSchema>["rules"][number];
export type RoutingHealthReport = z.output<typeof routingHealthSchema>;
export type RoutingBalancer = z.output<typeof balancerSchema>;
export type RoutingFailoverDrill = z.output<typeof failoverDrillSchema>;
export type RoutingPatternAnalysis = z.output<typeof patternConflictSchema>;
export type RoutingPreview = z.output<typeof routingPreviewSchema>;
export type RoutingDecisionEntry = z.output<typeof routingDecisionListSchema>["decisions"][number];
export type RoutingLearningReport = z.output<typeof routingLearningSchema>;
export type RoutingDomainReviewItem = z.output<typeof domainReviewSchema>["items"][number];
export type RoutingCostEstimate = z.output<typeof costEstimateSchema>;
