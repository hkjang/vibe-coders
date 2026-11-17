import { z } from "zod";
import type {
  PostAdminRedteamCampaignsIdRunReviewData,
  PostAdminRedteamCampaignsIdRunReviewedData,
  RedTeamRunReviewResponse,
  RedTeamReviewedExecutionResponse,
} from "@/shared/api/generated";
import { operation } from "@/shared/api/endpoint-factory";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite().nonnegative();
const kind = z.enum(["live", "simulation"]);
export const reviewedLimitsSchema = z.object({
  max_calls: z.number().int().min(1).max(200),
  max_output_tokens: z.number().int().min(1).max(4096),
  budget_limit_krw: z.number().finite().positive().max(1_000_000),
});
export const reviewedModelsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) => value === value.trim() && !/[?*\r\n]/u.test(value),
        "와일드카드 없이 정확한 모델 이름을 입력하세요.",
      ),
  )
  .max(200)
  .refine((value) => new Set(value).size === value.length, "모델 이름이 중복됩니다.");
export const redTeamReviewSchema = z
  .object({
    review_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    review_id: z.string().min(1),
    expires_at: z.iso.datetime({ offset: true }),
    scope: z.literal("responding_server"),
    campaign_id: z.string().min(1),
    campaign_name: z.string().min(1),
    kind,
    reason: z.string().min(1).max(1000),
    targets: z
      .array(
        z.object({
          id: z.string().min(1),
          target_ref: z.string(),
          provider: z.string(),
          models: reviewedModelsSchema,
          live_calls: count,
          case_executions: count,
        }),
      )
      .min(1)
      .max(1000),
    probe_pack_ids: z.array(z.string().min(1)).min(1),
    limits: reviewedLimitsSchema,
    planned_live_calls: count.max(200),
    case_executions: count.min(1).max(1000),
    estimated_cost_krw: amount,
    requested_output_tokens: count,
    registered_input_bytes: count,
    timeout_ms: count.min(1).max(120000),
    retain_raw_evidence: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const totals = value.targets.reduce(
      (sum, row) => ({ live: sum.live + row.live_calls, cases: sum.cases + row.case_executions }),
      { live: 0, cases: 0 },
    );
    if (
      totals.live !== value.planned_live_calls ||
      totals.cases !== value.case_executions ||
      value.planned_live_calls > value.limits.max_calls ||
      value.requested_output_tokens !== value.planned_live_calls * value.limits.max_output_tokens ||
      value.estimated_cost_krw > value.limits.budget_limit_krw ||
      (value.kind === "live" ? value.planned_live_calls === 0 : value.planned_live_calls !== 0)
    )
      ctx.addIssue({ code: "custom", message: "실행 검토 집계가 일치하지 않습니다." });
  }) satisfies z.ZodType<RedTeamRunReviewResponse>;
export const reviewedOutcomeSchema = z
  .object({
    campaign_id: z.string().min(1),
    status: z.enum(["completed", "stopped"]),
    stopped: z.string(),
    note: z.string(),
    runs: z.array(
      z.object({
        id: z.string().min(1),
        campaign_id: z.string(),
        target_id: z.string(),
        started_at: z.string(),
        ended_at: z.string(),
        status: z.string(),
        mode: z.string(),
        created_at: z.string(),
        total_cases: count,
        failed_cases: count,
        risk_score: count,
        cost_krw: amount,
      }),
    ),
    summary: z.object({
      runs: count,
      results: count,
      warnings: count,
      failures: count,
      critical: count,
      live_calls: count,
      live_cost_krw: amount,
      mode: z.string(),
    }),
    review_id: z.string().min(1),
    execution_kind: kind,
    limits: reviewedLimitsSchema,
    planned_live_calls: count,
    planned_case_executions: count,
    complete: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (
      value.summary.live_calls > value.planned_live_calls ||
      value.summary.results > value.planned_case_executions ||
      value.summary.runs !== value.runs.length ||
      (value.complete &&
        (value.status !== "completed" ||
          value.stopped !== "" ||
          value.summary.live_calls !== value.planned_live_calls ||
          value.summary.results !== value.planned_case_executions))
    )
      ctx.addIssue({ code: "custom", message: "실행 결과 집계가 일치하지 않습니다." });
  }) satisfies z.ZodType<RedTeamReviewedExecutionResponse>;
export const redTeamReviewedEndpoints = {
  review: operation<PostAdminRedteamCampaignsIdRunReviewData, RedTeamRunReviewResponse>()(
    "POST",
    "/admin/redteam/campaigns/{id}/run-review",
    redTeamReviewSchema,
  ),
  execute: operation<PostAdminRedteamCampaignsIdRunReviewedData, RedTeamReviewedExecutionResponse>()(
    "POST",
    "/admin/redteam/campaigns/{id}/run-reviewed",
    reviewedOutcomeSchema,
  ),
};
export type ReviewedRedTeamRun = z.output<typeof redTeamReviewSchema>;
export type ReviewedRedTeamOutcome = z.output<typeof reviewedOutcomeSchema>;
