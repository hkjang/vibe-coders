import type { runSortFields } from "@/shared/utils/redteam-run-query";
export const runSortLabels: Readonly<Record<(typeof runSortFields)[number], string>> = {
  created_at: "실행 시각",
  id: "실행 ID",
  status: "상태",
  total_cases: "전체 검사 수",
  failed_cases: "실패 검사 수",
  risk_score: "위험 점수",
  cost_krw: "비용(원)",
};
