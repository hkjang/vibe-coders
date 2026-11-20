import { apiClient } from "@/shared/api/client";
import { withPathParams } from "@/shared/api/domains/redteam";
import { redTeamJobEndpoints } from "@/shared/api/domains/redteam-jobs";
import type { ReviewedRedTeamRun } from "@/shared/api/domains/redteam-reviewed";
import { AppError } from "@/shared/api/error";

export async function submitReviewedJob(review: ReviewedRedTeamRun, key: string) {
  const job = await apiClient.request(withPathParams(redTeamJobEndpoints.start, { id: review.campaign_id }), {
    body: { review_token: review.review_token, ...(review.kind === "live" ? { proxy_key: key.trim() } : {}) },
    query: { job: "1" },
    routeId: "security.redteam",
    retryUnauthorized: false,
  });
  if (
    job.id !== review.job_id ||
    job.campaign_id !== review.campaign_id ||
    job.review_id !== review.review_id ||
    job.kind !== review.kind ||
    job.reason !== review.reason ||
    job.planned_live_calls !== review.planned_live_calls ||
    job.planned_case_executions !== review.case_executions
  )
    throw new AppError("접수된 작업과 검토 조건이 일치하지 않습니다.", { kind: "contract" });
  return job;
}
