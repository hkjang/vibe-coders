import { z } from "zod";
import type {
  RedTeamExecutionJob,
  GetAdminRedteamCampaignsIdRunReviewedData,
  PostAdminRedteamCampaignsIdRunReviewedData,
} from "@/shared/api/generated";
import { operation } from "@/shared/api/endpoint-factory";
import { reviewedOutcomeSchema } from "./redteam-reviewed";

const count = z.number().int().nonnegative();
export const redTeamJobSchema = z
  .object({
    id: z.string().regex(/^rtj_[a-f0-9]{64}$/u),
    campaign_id: z.string().min(1),
    review_id: z.string().min(1),
    kind: z.enum(["live", "simulation"]),
    reason: z.string().min(1).max(1000),
    planned_live_calls: count.max(200),
    planned_case_executions: count.min(1).max(1000),
    status: z.enum(["running", "completed", "stopped", "unknown", "interrupted"]),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    finished_at: z.union([z.literal(""), z.iso.datetime({ offset: true })]),
    progress: z.object({
      run_ids: z.array(z.string().min(1)).max(1000),
      live_calls: count.max(200),
      completed_cases: count.max(1000),
      cost_krw: z.number().finite().nonnegative(),
    }),
    outcome: reviewedOutcomeSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const result = value.outcome;
    if (
      value.progress.live_calls > value.planned_live_calls ||
      value.progress.completed_cases > value.planned_case_executions ||
      (value.status === "completed" && !result?.complete) ||
      (result &&
        (result.review_id !== value.review_id ||
          result.campaign_id !== value.campaign_id ||
          result.execution_kind !== value.kind ||
          result.planned_live_calls !== value.planned_live_calls ||
          result.planned_case_executions !== value.planned_case_executions))
    ) {
      ctx.addIssue({ code: "custom", message: "실행 작업의 대상과 집계를 확인하지 못했습니다." });
    }
  }) satisfies z.ZodType<RedTeamExecutionJob>;
export const redTeamJobEndpoints = {
  read: operation<GetAdminRedteamCampaignsIdRunReviewedData, RedTeamExecutionJob>()(
    "GET",
    "/admin/redteam/campaigns/{id}/run-reviewed",
    redTeamJobSchema,
    z.object({ job_id: z.string().regex(/^rtj_[a-f0-9]{64}$/u) }).strict(),
  ),
  start: operation<PostAdminRedteamCampaignsIdRunReviewedData, RedTeamExecutionJob>()(
    "POST",
    "/admin/redteam/campaigns/{id}/run-reviewed",
    redTeamJobSchema,
    z.object({ job: z.literal("1") }).strict(),
  ),
};
export type RedTeamJobView = z.output<typeof redTeamJobSchema>;
