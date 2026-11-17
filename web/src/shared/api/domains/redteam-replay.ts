import { z } from "zod";
import type {
  PostAdminRedteamResultsIdRerunReviewData,
  PostAdminRedteamResultsIdRerunReviewedData,
  RedTeamReplayReviewResponse,
  RedTeamReplayExecutionResponse,
} from "@/shared/api/generated";
import { operation } from "@/shared/api/endpoint-factory";
import { redTeamReviewSchema, reviewedOutcomeSchema } from "./redteam-reviewed";

const count = z.number().int().nonnegative();
export const replayReviewSchema = redTeamReviewSchema
  .safeExtend({
    kind: z.literal("live"),
    source_result: z.object({
      id: z.string().min(1),
      run_id: z.string().min(1),
      case_id: z.string().min(1),
      request_id: z.string(),
      decision: z.string(),
      severity: z.string(),
      evidence_hash: z.string(),
      policy_decision: z.string(),
      latency_ms: count,
      cost_krw: z.number().finite().nonnegative(),
      created_at: z.string(),
    }),
    case_key: z.string(),
    pack_name: z.string(),
  })
  .superRefine((value, ctx) => {
    if (
      value.planned_live_calls !== 1 ||
      value.case_executions !== 1 ||
      value.limits.max_calls !== 1 ||
      value.targets.length !== 1 ||
      value.targets[0]?.models.length !== 1
    )
      ctx.addIssue({ code: "custom", message: "한 건의 재실행 검토가 아닙니다." });
  }) satisfies z.ZodType<RedTeamReplayReviewResponse>;

export const replayOutcomeSchema = reviewedOutcomeSchema
  .safeExtend({
    source_result_id: z.string().min(1),
    source_run_id: z.string().min(1),
    execution_kind: z.literal("live"),
    runs: z
      .array(
        reviewedOutcomeSchema.shape.runs.element.safeExtend({
          source_result_id: z.string().min(1),
          review_id: z.string().min(1),
        }),
      )
      .max(1),
  })
  .superRefine((value, ctx) => {
    if (
      value.planned_live_calls !== 1 ||
      value.planned_case_executions !== 1 ||
      value.limits.max_calls !== 1 ||
      value.runs.some(
        (run) =>
          run.id === value.source_run_id ||
          run.source_result_id !== value.source_result_id ||
          run.review_id !== value.review_id,
      )
    )
      ctx.addIssue({ code: "custom", message: "재실행 출처 또는 실행 범위가 일치하지 않습니다." });
  }) satisfies z.ZodType<RedTeamReplayExecutionResponse>;

export const redTeamReplayEndpoints = {
  review: operation<PostAdminRedteamResultsIdRerunReviewData, RedTeamReplayReviewResponse>()(
    "POST",
    "/admin/redteam/results/{id}/rerun-review",
    replayReviewSchema,
  ),
  execute: operation<PostAdminRedteamResultsIdRerunReviewedData, RedTeamReplayExecutionResponse>()(
    "POST",
    "/admin/redteam/results/{id}/rerun-reviewed",
    replayOutcomeSchema,
  ),
};
export type ReviewedRedTeamReplay = z.output<typeof replayReviewSchema>;
export type RedTeamReplayOutcome = z.output<typeof replayOutcomeSchema>;
