import type { ReviewedRedTeamReplay, RedTeamReplayOutcome } from "@/shared/api/domains/redteam-replay";
import { executionReviewFixture, executionOutcomeFixture } from "./reviewed-execution-fixture";

export function replayReviewFixture(overrides: Partial<ReviewedRedTeamReplay> = {}): ReviewedRedTeamReplay {
  return {
    ...executionReviewFixture({ limits: { max_calls: 1, max_output_tokens: 512, budget_limit_krw: 10 } }),
    kind: "live",
    source_result: {
      id: "public-source-result",
      run_id: "public-source-run",
      case_id: "public-case",
      request_id: "",
      decision: "pass",
      severity: "low",
      evidence_hash: "public-hash",
      policy_decision: "block",
      latency_ms: 20,
      cost_krw: 0,
      created_at: "2026-11-01T00:00:00Z",
    },
    case_key: "공개 검사",
    pack_name: "공개 검사 묶음",
    ...overrides,
  };
}

export function replayOutcomeFixture(review = replayReviewFixture()): RedTeamReplayOutcome {
  const outcome = executionOutcomeFixture(review);
  return {
    ...outcome,
    execution_kind: "live",
    source_result_id: review.source_result.id,
    source_run_id: review.source_result.run_id,
    runs: outcome.runs.map((run) => ({
      ...run,
      source_result_id: review.source_result.id,
      review_id: review.review_id,
    })),
  };
}
