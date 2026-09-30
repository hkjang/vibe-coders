import type { ProviderImpact, ProviderImpactSection } from "@/shared/api/domains/provider-impact";

export const providerImpactCategories = [
  { key: "routing_rules", title: "라우팅 규칙", description: "현재 공급자를 직접 지정한 규칙입니다." },
  {
    key: "agent_routes",
    title: "에이전트 경로",
    description: "현재 공급자를 직접 지정한 에이전트 경로입니다.",
  },
  {
    key: "failover_peers",
    title: "장애 전환 후보",
    description: "현재 설정의 같은 장애 전환 그룹이며, 호출 성공 여부는 확인하지 않습니다.",
  },
  {
    key: "api_keys",
    title: "API 키 설정",
    description: "현재 공급자 접근 설정의 후보입니다. 실제 호출 권한·사용량이 아닙니다.",
  },
  {
    key: "teams",
    title: "관련 팀 설정",
    description: "후보 API 키에 연결된 팀입니다. 모든 팀 권한이나 실제 사용 팀을 뜻하지 않습니다.",
  },
] as const satisfies readonly { key: keyof ProviderImpact; title: string; description: string }[];

const reasons: Record<ProviderImpactSection["reason"], string> = {
  "": "이 범위의 현재 설정을 조회했습니다.",
  bounded_or_unassessable_configuration: "조회 상한 또는 해석할 수 없는 설정 때문에 일부만 확인했습니다.",
  routing_read_required: "라우팅 조회 권한(routing:read)이 필요해 이 항목을 확인하지 못했습니다.",
  configuration_read_failed: "설정 조회에 실패해 이 항목을 확인하지 못했습니다.",
  target_configuration_unassessable: "대상 설정을 해석할 수 없어 이 항목을 확인하지 못했습니다.",
  team_scoped_assessment_not_available: "팀 범위 계정에서는 이 영향 범위를 조회할 수 없습니다.",
  key_configuration_unavailable: "API 키 설정을 조회하지 못해 관련 팀도 확인하지 못했습니다.",
  team_configuration_read_failed: "팀 설정 조회에 실패해 관련 팀을 확인하지 못했습니다.",
};

export function providerImpactReason(section: ProviderImpactSection): string {
  return reasons[section.reason];
}

export function providerImpactCount(section: ProviderImpactSection): string {
  if (section.count_kind === "unknown" || section.matched_count === null) return "확인하지 못함";
  if (section.count_kind === "lower_bound") return `확인된 최소 ${section.matched_count}건 · 전체 미확인`;
  return `설정 참조 ${section.matched_count}건`;
}
