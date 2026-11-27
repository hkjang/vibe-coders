import { z } from "zod";

import { categoryRefSchema, workMaxOffset, workRequestSchema } from "@/shared/api/domains/insights-common";
import { operation } from "@/shared/api/endpoint-factory";
import type {
  GetAdminWorkIntelPolicyData,
  GetAdminWorkIntelPolicyResponse,
  GetAdminWorkIntelPolicyVersionsData,
  GetAdminWorkIntelPolicyVersionsResponse,
  GetAdminWorkIntelPolicyVersionsVersionData,
  GetAdminWorkIntelPolicyVersionsVersionResponse,
  GetAdminWorkIntelReclassifyData,
  GetAdminWorkIntelReclassifyJobsIdData,
  GetAdminWorkIntelReclassifyJobsIdResponse,
  GetAdminWorkIntelReclassifyResponse,
  GetAdminWorkIntelReviewData,
  GetAdminWorkIntelReviewResponse,
  GetAdminWorkIntelStatusData,
  GetAdminWorkIntelStatusResponse,
  PostAdminWorkIntelPolicyEvaluateData,
  PostAdminWorkIntelPolicyEvaluateResponse,
  PostAdminWorkIntelPolicyPublishData,
  PostAdminWorkIntelPolicyPublishResponse,
  PostAdminWorkIntelPolicyRollbackData,
  PostAdminWorkIntelPolicyRollbackResponse,
  PostAdminWorkIntelPolicyTestData,
  PostAdminWorkIntelPolicyTestResponse,
  PostAdminWorkIntelRebuildData,
  PostAdminWorkIntelRebuildResponse,
  PostAdminWorkIntelReclassifyData,
  PostAdminWorkIntelReclassifyResponse,
  PostAdminWorkIntelReviewCorrectData,
  PostAdminWorkIntelReviewCorrectResponse,
  PutAdminWorkIntelPolicyData,
  PutAdminWorkIntelPolicyResponse,
} from "@/shared/api/generated";
import { looseObject, orDefault } from "@/shared/api/loose";

// The classification console's API (docs/WORK_INTELLIGENCE_DESIGN.md §7 "분류 관리").
// The server documents every response as an open object, so these schemas are the
// contract the console reads them by. The policy document is parsed loosely on
// purpose: a field this console does not know yet survives a load → save round trip.

const text = orDefault(z.string(), "");
const count = orDefault(z.number(), 0);
const flag = orDefault(z.boolean(), false);
const list = orDefault(z.array(z.string()), []);
const tally = orDefault(z.record(z.string(), z.number()), {});

export const workRulesSchema = looseObject({
  keywords: list,
  mcp_servers: list,
  mcp_tools: list,
  languages: list,
  task_types: list,
  clients: list,
  weight: orDefault(z.number(), 1),
});
export type WorkRules = z.output<typeof workRulesSchema>;

export const emptyWorkRules: WorkRules = {
  keywords: [],
  mcp_servers: [],
  mcp_tools: [],
  languages: [],
  task_types: [],
  clients: [],
  weight: 1,
};

export const workCategorySchema = looseObject({
  id: z.string(),
  parent_id: text,
  name: text,
  description: text,
  examples: list,
  enabled: orDefault(z.boolean(), true),
  merged_into: text,
  rules: orDefault(workRulesSchema, emptyWorkRules),
});
export type WorkCategory = z.output<typeof workCategorySchema>;

export const workActionTypeSchema = looseObject({
  id: z.string(),
  name: text,
  keywords: list,
});
export type WorkActionType = z.output<typeof workActionTypeSchema>;

export const workThresholdsSchema = looseObject({
  accept: orDefault(z.number(), 0.72),
  review_below: orDefault(z.number(), 0.5),
  min_evidence: orDefault(z.number(), 2),
  min_group_size: orDefault(z.number(), 3),
});
export type WorkThresholds = z.output<typeof workThresholdsSchema>;

export const defaultWorkThresholds: WorkThresholds = {
  accept: 0.72,
  review_below: 0.5,
  min_evidence: 2,
  min_group_size: 3,
};

export const workLLMSchema = looseObject({
  system_prompt: text,
  max_input_chars: orDefault(z.number(), 1500),
});
export type WorkLLMConfig = z.output<typeof workLLMSchema>;

export const workBaselineSchema = looseObject({
  category_id: z.string(),
  manual_minutes: count,
  ai_minutes: count,
  hourly_cost_krw: count,
  note: text,
});
export type WorkBaseline = z.output<typeof workBaselineSchema>;

export const workPolicyConfigSchema = looseObject({
  categories: orDefault(z.array(workCategorySchema), []),
  action_types: orDefault(z.array(workActionTypeSchema), []),
  thresholds: orDefault(workThresholdsSchema, defaultWorkThresholds),
  llm: orDefault(workLLMSchema, { system_prompt: "", max_input_chars: 1500 }),
  baselines: orDefault(z.array(workBaselineSchema), []),
});
export type WorkPolicyConfig = z.output<typeof workPolicyConfigSchema>;

const policySchema = looseObject({
  config: workPolicyConfigSchema,
  revision: count,
  updated_by: text,
  updated_at: text,
  published_version: count,
  published_at: text,
  dirty: flag,
  defaults: orDefault(
    looseObject({
      action_types: orDefault(z.array(workActionTypeSchema), []),
      thresholds: orDefault(workThresholdsSchema, defaultWorkThresholds),
    }),
    { action_types: [], thresholds: defaultWorkThresholds },
  ),
});
export type WorkPolicy = z.output<typeof policySchema>;

/** The saved draft. Publication state is re-read from `GET /policy` after a save. */
const policyWriteSchema = looseObject({
  config: workPolicyConfigSchema,
  revision: count,
  updated_by: text,
  updated_at: text,
});
export type WorkPolicyWrite = z.output<typeof policyWriteSchema>;

export const workPolicyIssueSchema = z.object({ path: z.string(), message: z.string() });
export type WorkPolicyIssue = z.output<typeof workPolicyIssueSchema>;

/** The body of a 422 `work_policy_invalid`: what is wrong, by path into the policy. */
export const workPolicyRejectionSchema = looseObject({ issues: z.array(workPolicyIssueSchema) });

const noChanges = { added: [], removed: [], renamed: [], merged: [], rules_changed: [] };

const versionChangesSchema = looseObject({
  added: list,
  removed: list,
  renamed: list,
  merged: list,
  rules_changed: list,
});
export type WorkVersionChanges = z.output<typeof versionChangesSchema>;

const versionRowSchema = looseObject({
  version: z.number(),
  note: text,
  published_by: text,
  published_at: text,
  categories: count,
  changes: orDefault(versionChangesSchema, noChanges),
});
export type WorkPolicyVersionRow = z.output<typeof versionRowSchema>;

const versionsSchema = looseObject({ versions: orDefault(z.array(versionRowSchema), []) });

const versionSchema = looseObject({
  version: z.number(),
  config: workPolicyConfigSchema,
  note: text,
  published_by: text,
  published_at: text,
});
export type WorkPolicyVersion = z.output<typeof versionSchema>;

const publishSchema = looseObject({
  version: count,
  published_at: text,
  impact: orDefault(looseObject({ categories_removed: count, affected_requests: count }), {
    categories_removed: 0,
    affected_requests: 0,
  }),
});
export type WorkPublishResult = z.output<typeof publishSchema>;

/** A rollback publishes the old content as a new version; the draft is re-read afterwards. */
const rollbackSchema = looseObject({ version: count, published_at: text });
export type WorkRollbackResult = z.output<typeof rollbackSchema>;

/**
 * One classification outcome. The design names it "분류 결과" without listing its
 * members; the console reads the members a classified request row carries and
 * accepts the category either as a reference or as a bare id.
 */
const classificationSchema = looseObject({
  category: orDefault(categoryRefSchema.nullable(), null),
  category_id: text,
  action_type: text,
  confidence: count,
  method: text,
  status: text,
  tags: list,
  technologies: list,
  work_title: text,
  target_system: text,
  new_category_hint: text,
});
export type WorkClassification = z.output<typeof classificationSchema>;

const candidateSchema = looseObject({
  category: categoryRefSchema,
  score: count,
  evidence: list,
});
export type WorkCandidate = z.output<typeof candidateSchema>;

const policyTestSchema = looseObject({
  result: classificationSchema,
  candidates: orDefault(z.array(candidateSchema), []),
  /** `code` is set for a known refusal such as `llm_budget_exhausted`; `error` carries the message. */
  llm: orDefault(looseObject({ used: flag, error: text, code: text }), { used: false, error: "", code: "" }),
});
export type WorkPolicyTestResult = z.output<typeof policyTestSchema>;

const evaluateSchema = looseObject({
  sample: count,
  accuracy: orDefault(z.number().nullable(), null),
  top_accuracy: orDefault(z.number().nullable(), null),
  by_category: orDefault(
    z.array(looseObject({ category: categoryRefSchema, total: count, correct: count })),
    [],
  ),
  confusions: orDefault(z.array(looseObject({ expected: text, got: text, count: count })), []),
  note: text,
});
export type WorkEvaluation = z.output<typeof evaluateSchema>;

const reviewSchema = looseObject({
  rows: orDefault(z.array(workRequestSchema), []),
  count: count,
  limit: count,
  offset: count,
  summary: orDefault(
    looseObject({
      review: count,
      unclassified: count,
      failed: count,
      new_category_hints: orDefault(z.array(looseObject({ hint: z.string(), count: count })), []),
    }),
    { review: 0, unclassified: 0, failed: 0, new_category_hints: [] },
  ),
});
export type WorkReviewQueue = z.output<typeof reviewSchema>;

const correctSchema = looseObject({ corrected: count, days_rebuilt: list });
export type WorkCorrectionResult = z.output<typeof correctSchema>;

/** The server reports rebuilt days either as a count or as the list of days. */
const daysRebuilt = orDefault(z.union([z.number(), z.array(z.string())]), 0);

export const workJobStatuses = ["queued", "running", "succeeded", "failed", "interrupted"] as const;
export type WorkJobStatus = (typeof workJobStatuses)[number];

export const workJobSchema = looseObject({
  id: z.string(),
  status: text,
  actor: text,
  created_at: text,
  updated_at: text,
  progress: orDefault(
    looseObject({
      total: count,
      done: count,
      changed: count,
      failed: count,
      days_rebuilt: daysRebuilt,
      kept_no_text: count,
      /** What the reviewed preview counted; 0 when the server does not say. May differ from `total`. */
      previewed: count,
    }),
    { total: 0, done: 0, changed: 0, failed: 0, days_rebuilt: 0, kept_no_text: 0, previewed: 0 },
  ),
});
export type WorkJob = z.output<typeof workJobSchema>;

const reclassifyPreviewSchema = looseObject({
  revision: text,
  reviewed_at: text,
  expires_at: text,
  total: count,
  by_status: tally,
  by_method: tally,
  manual_kept: count,
  no_text_kept: count,
  /** The text lookup is bounded; true means no_text_kept is a lower bound. */
  no_text_capped: orDefault(z.boolean(), false),
  est_llm_calls: count,
  days: count,
  active_job: orDefault(workJobSchema.nullable(), null),
});
export type WorkReclassifyPreview = z.output<typeof reclassifyPreviewSchema>;

const rebuildSchema = looseObject({ days_rebuilt: daysRebuilt });
export type WorkRebuildResult = z.output<typeof rebuildSchema>;

const statusSchema = looseObject({
  classify_enabled: flag,
  analytics_enabled: flag,
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
  by_method: tally,
  failures_24h: count,
  llm_calls_24h: count,
  llm_tokens_24h: count,
  llm_cost_krw_24h: count,
  cache_hits_24h: count,
  worker_active: flag,
});
export type WorkIntelStatus = z.output<typeof statusSchema>;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const workReviewStatuses = ["review", "unclassified", "failed"] as const;
export type WorkReviewStatus = (typeof workReviewStatuses)[number];

export const workReviewQuerySchema = z
  .object({
    status: z.enum(workReviewStatuses).optional(),
    category: z.string().max(128).optional(),
    max_conf: z.number().min(0).max(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).max(workMaxOffset).optional(),
  })
  .strict();
export type WorkReviewQuery = z.input<typeof workReviewQuerySchema>;

export const workReclassifyQuerySchema = z
  .object({
    from: day.optional(),
    to: day.optional(),
    status: z.string().max(32).optional(),
    category: z.string().max(128).optional(),
    method: z.string().max(32).optional(),
  })
  .strict();
export type WorkReclassifyQuery = z.input<typeof workReclassifyQuerySchema>;

const reviewedQuerySchema = z.object({ reviewed: z.literal("1") }).strict();

export const insightsClassificationEndpoints = {
  status: operation<GetAdminWorkIntelStatusData, GetAdminWorkIntelStatusResponse>()(
    "GET",
    "/admin/work-intel/status",
    statusSchema,
  ),
  policy: operation<GetAdminWorkIntelPolicyData, GetAdminWorkIntelPolicyResponse>()(
    "GET",
    "/admin/work-intel/policy",
    policySchema,
  ),
  savePolicy: operation<PutAdminWorkIntelPolicyData, PutAdminWorkIntelPolicyResponse>()(
    "PUT",
    "/admin/work-intel/policy",
    policyWriteSchema,
  ),
  versions: operation<GetAdminWorkIntelPolicyVersionsData, GetAdminWorkIntelPolicyVersionsResponse>()(
    "GET",
    "/admin/work-intel/policy/versions",
    versionsSchema,
  ),
  /** Bind `{version}` with `withPathParams`. */
  version: operation<
    GetAdminWorkIntelPolicyVersionsVersionData,
    GetAdminWorkIntelPolicyVersionsVersionResponse
  >()("GET", "/admin/work-intel/policy/versions/{version}", versionSchema),
  publish: operation<PostAdminWorkIntelPolicyPublishData, PostAdminWorkIntelPolicyPublishResponse>()(
    "POST",
    "/admin/work-intel/policy/publish",
    publishSchema,
  ),
  rollback: operation<PostAdminWorkIntelPolicyRollbackData, PostAdminWorkIntelPolicyRollbackResponse>()(
    "POST",
    "/admin/work-intel/policy/rollback",
    rollbackSchema,
  ),
  test: operation<PostAdminWorkIntelPolicyTestData, PostAdminWorkIntelPolicyTestResponse>()(
    "POST",
    "/admin/work-intel/policy/test",
    policyTestSchema,
  ),
  evaluate: operation<PostAdminWorkIntelPolicyEvaluateData, PostAdminWorkIntelPolicyEvaluateResponse>()(
    "POST",
    "/admin/work-intel/policy/evaluate",
    evaluateSchema,
  ),
  review: operation<GetAdminWorkIntelReviewData, GetAdminWorkIntelReviewResponse>()(
    "GET",
    "/admin/work-intel/review",
    reviewSchema,
    workReviewQuerySchema,
  ),
  correct: operation<PostAdminWorkIntelReviewCorrectData, PostAdminWorkIntelReviewCorrectResponse>()(
    "POST",
    "/admin/work-intel/review/correct",
    correctSchema,
  ),
  reclassifyPreview: operation<GetAdminWorkIntelReclassifyData, GetAdminWorkIntelReclassifyResponse>()(
    "GET",
    "/admin/work-intel/reclassify",
    reclassifyPreviewSchema,
    workReclassifyQuerySchema,
  ),
  reclassifyRun: operation<PostAdminWorkIntelReclassifyData, PostAdminWorkIntelReclassifyResponse>()(
    "POST",
    "/admin/work-intel/reclassify",
    workJobSchema,
    reviewedQuerySchema,
  ),
  /** Bind `{id}` with `withPathParams`. */
  reclassifyJob: operation<
    GetAdminWorkIntelReclassifyJobsIdData,
    GetAdminWorkIntelReclassifyJobsIdResponse
  >()("GET", "/admin/work-intel/reclassify/jobs/{id}", workJobSchema),
  rebuild: operation<PostAdminWorkIntelRebuildData, PostAdminWorkIntelRebuildResponse>()(
    "POST",
    "/admin/work-intel/rebuild",
    rebuildSchema,
  ),
} as const;
