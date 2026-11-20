const actionTitles = new Map<string, string>([
  ["key_expiry", "API 키 만료 확인"],
  ["failure_increase", "오류 요청 점검"],
  ["unreviewed_recommendations", "새 추천 검토"],
  ["model_switch", "모델 사용 검토"],
  ["mcp_recommend", "도구 사용 검토"],
  ["cost_increase", "사용 비용 점검"],
]);

export function meActionTitle(type: string): string {
  return actionTitles.get(type) ?? "운영 신호 확인";
}
