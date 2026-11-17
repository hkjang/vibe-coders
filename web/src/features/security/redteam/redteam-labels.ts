const label = (labels: Readonly<Record<string, string>>, value: string | undefined): string => {
  const key = (value ?? "").trim().toLowerCase();
  const translated = Object.hasOwn(labels, key) ? labels[key] : undefined;
  return translated ?? (value || "—");
};

const riskLabels = { low: "낮음", medium: "보통", high: "높음", critical: "치명" };
const policyLabels = {
  safe_completion: "안전한 응답",
  refuse: "응답 거부",
  block: "요청 차단",
  mask: "민감정보 마스킹",
  approval_required: "승인 요청",
  no_tool_call: "도구 호출 금지",
  limit_or_warning: "한도 적용 또는 경고",
  allow: "허용",
};
const evaluatorLabels = {
  rule: "규칙 검사",
  tool_call: "도구 호출 검사",
  judge: "모델 판정",
  sql: "SQL 검사",
  cost: "비용 검사",
  policy: "정책 검사",
  header: "헤더 검사",
};
export const probeTargetTypes = [
  { value: "provider", label: "제공자" },
  { value: "model", label: "모델" },
  { value: "ai_app", label: "AI 앱" },
  { value: "mcp_tool", label: "MCP 도구" },
  { value: "text2sql", label: "자연어 SQL" },
  { value: "workflow", label: "워크플로" },
] as const;
const targetLabels = Object.fromEntries(probeTargetTypes.map((option) => [option.value, option.label]));
const categoryLabels = {
  prompt_injection: "프롬프트 주입",
  data_leakage: "데이터 유출",
  tool_misuse: "도구 오용",
  custom: "사용자 정의",
  redteam: "레드팀",
};

export const riskLabel = (value: string | undefined): string => label(riskLabels, value);
export const expectedPolicyLabel = (value: string | undefined): string => label(policyLabels, value);
export const evaluatorTypeLabel = (value: string | undefined): string => label(evaluatorLabels, value);
export const targetTypeLabel = (value: string | undefined): string => label(targetLabels, value);
export const probeCategoryLabel = (value: string | undefined): string => label(categoryLabels, value);
