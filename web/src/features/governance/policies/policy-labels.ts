export const conditionLabels = {
  contains_secret: "비밀정보 포함",
  risk_score: "위험 점수",
  complexity_score: "복잡도 점수",
  cost_krw: "비용(원)",
  team: "팀",
  role: "역할",
  model: "모델",
  provider: "공급자",
  mcp_tool: "MCP 도구",
} as const;

export const actionLabels = {
  block: "차단",
  require_approval: "승인 필요",
  secret_mask: "비밀정보 가리기",
  secret_block: "비밀정보 차단",
  deny_models: "모델 차단",
  allow_models: "모델 허용",
  deny_providers: "공급자 차단",
  allow_providers: "공급자 허용",
} as const;

export const policyDecisionOptions = [
  { value: "allow", label: "허용" },
  { value: "block", label: "차단" },
  { value: "require_approval", label: "승인 필요" },
] as const;

export function policyDecisionLabel(value: string | undefined): string {
  return policyDecisionOptions.find((option) => option.value === value)?.label ?? (value || "—");
}
