import type { RedTeamJobView } from "@/shared/api/domains/redteam-jobs";
import { executionOutcomeFixture, executionReviewFixture } from "./reviewed-execution-fixture";

export const executionJobId = `rtj_${"a".repeat(64)}`;
export function executionJobFixture(complete = false): RedTeamJobView {
  const review = executionReviewFixture();
  return {
    id: executionJobId,
    campaign_id: review.campaign_id,
    review_id: review.review_id,
    kind: review.kind,
    reason: review.reason,
    planned_live_calls: review.planned_live_calls,
    planned_case_executions: review.case_executions,
    created_at: "2026-11-20T08:00:00.000000000Z",
    updated_at: "2026-11-20T08:01:00.000000000Z",
    finished_at: complete ? "2026-11-20T08:01:00.000000000Z" : "",
    status: complete ? "completed" : "running",
    progress: {
      run_ids: ["public-run"],
      live_calls: 1,
      completed_cases: complete ? 1 : 0,
      cost_krw: complete ? 0.5 : 0,
    },
    outcome: complete ? executionOutcomeFixture(review) : null,
  };
}
