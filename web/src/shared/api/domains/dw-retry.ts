import { z } from "zod";
import { operation, type WithBody, type WithQuery } from "@/shared/api/endpoint-factory";
import type {
  DwRetryReview,
  DwRetryRun,
  DwRetryReviewedRequest,
  GetAdminDwSinkRetryData,
  PostAdminDwSinkRetryData,
} from "@/shared/api/generated";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const dwRetryRunId = z.string().regex(/^dwr_[a-f0-9]{64}$/u);
const dimension = z.object({
  dimension: z.string(),
  since: z.string(),
  until: z.string(),
  estimated_rows: count,
  sent_rows: count,
  status: z.enum(["queued", "blocked", "running", "succeeded", "failed", "pending", "not_run"]),
  issue: z.enum([
    "",
    "invalid_source_interval",
    "not_configured",
    "fact_not_configured",
    "delivery_incomplete",
    "completion_unconfirmed",
    "new_failure_queued",
    "operation_interrupted",
  ]),
});
const review = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    run_id: dwRetryRunId,
    reviewed_at: z.string(),
    expires_at: z.string(),
    all: z.boolean(),
    eligible_dimensions: count,
    estimated_rows: count,
    dimensions: z.array(dimension).max(64),
  })
  .refine((value) => value.run_id === `dwr_${value.revision}`, "검토 결과의 작업 ID가 일치하지 않습니다.");
const run = z.object({
  id: dwRetryRunId,
  status: z.enum(["running", "succeeded", "partial_failed", "failed", "interrupted"]),
  reviewed_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string(),
  progress: z.object({
    estimated_rows: count,
    sent_rows: count,
    finished_dimensions: count,
    dimensions: z.array(dimension).max(64),
  }),
});
export type DwRetryReviewView = z.output<typeof review>;
export type DwRetryRunView = z.output<typeof run>;
export type DwRetryDimensionView = z.output<typeof dimension>;
export type DwRetryInput = DwRetryReviewedRequest;
export const dwRetryEndpoints = {
  review: operation<GetAdminDwSinkRetryData, DwRetryReview>()("GET", "/admin/dw/sink-retry", review),
  job: operation<WithQuery<GetAdminDwSinkRetryData, { job_id: string }>, DwRetryRun>()(
    "GET",
    "/admin/dw/sink-retry",
    run,
    z.object({ job_id: dwRetryRunId }),
  ),
  start: operation<
    WithBody<WithQuery<PostAdminDwSinkRetryData, { reviewed: "1" }>, DwRetryInput>,
    DwRetryRun
  >()("POST", "/admin/dw/sink-retry", run, z.object({ reviewed: z.literal("1") })),
};
