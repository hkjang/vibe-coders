import type { ReviewedRedTeamRun, ReviewedRedTeamOutcome } from "@/shared/api/domains/redteam-reviewed";
export function executionReviewFixture(overrides: Partial<ReviewedRedTeamRun> = {}): ReviewedRedTeamRun {
  return {
    review_token: "r".repeat(43),
    review_id: "public-review",
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    scope: "responding_server",
    campaign_id: "public-campaign",
    campaign_name: "공개 실행",
    kind: "live",
    reason: "공개 실행 점검",
    targets: [
      {
        id: "public-target",
        target_ref: "공개 테스트 모델",
        provider: "public-provider",
        models: ["public-model"],
        live_calls: 1,
        case_executions: 1,
      },
    ],
    probe_pack_ids: ["public-pack"],
    limits: { max_calls: 20, max_output_tokens: 512, budget_limit_krw: 1000 },
    planned_live_calls: 1,
    case_executions: 1,
    estimated_cost_krw: 0.5,
    requested_output_tokens: 512,
    registered_input_bytes: 100,
    timeout_ms: 120000,
    retain_raw_evidence: false,
    ...overrides,
  };
}
export function executionOutcomeFixture(review = executionReviewFixture()): ReviewedRedTeamOutcome {
  return {
    recording: { confirmed: true, stage: "", results: 1 },
    campaign_id: review.campaign_id,
    status: "completed",
    stopped: "",
    runs: [
      {
        id: "public-run",
        campaign_id: review.campaign_id,
        target_id: "공개 테스트 모델",
        status: "passed",
        total_cases: 1,
        failed_cases: 0,
        risk_score: 0,
        cost_krw: 0.5,
        mode: "active-controlled",
        started_at: "",
        ended_at: "",
        created_at: "",
      },
    ],
    summary: {
      runs: 1,
      results: 1,
      live_calls: review.planned_live_calls,
      live_cost_krw: 0.5,
      mode: "active-controlled",
      warnings: 0,
      failures: 0,
      critical: 0,
    },
    note: "공개 테스트 데이터입니다. 실행 기록을 확인하세요.",
    review_id: review.review_id,
    execution_kind: review.kind,
    limits: review.limits,
    planned_live_calls: review.planned_live_calls,
    planned_case_executions: review.case_executions,
    complete: true,
  };
}
