import type { RedTeamDryRun } from "@/shared/api/domains/redteam";

/** Synthetic, public test fixture shared by component and browser coverage. */
export const preflightFixture: RedTeamDryRun = {
  campaign_id: "public-preflight",
  targets: 3,
  probe_packs: 2,
  case_executions: 12,
  estimated_cost_krw: 6,
  external_targets: 1,
  destructive_tool_targets: 1,
  active_eligible_targets: 2,
  models_selected: 2,
  requires_approval: true,
  approved: false,
  can_run: true,
  limits: { budget_limit_krw: 5, qps_limit: 0.5, concurrency: 1, timeout_ms: 30000 },
  note: "공개 검증용 서버 안내",
};
