export const apiKeyScopeOptions = [
  { value: "chat:completion", label: "대화 생성", description: "모델에 대화 완성을 요청합니다." },
  { value: "embeddings:create", label: "임베딩 생성", description: "입력 내용을 벡터로 변환합니다." },
  { value: "models:read", label: "모델 조회", description: "사용 가능한 모델 정보를 조회합니다." },
  { value: "admin:read", label: "관리 정보 조회", description: "관리 화면의 정보를 조회합니다." },
  { value: "admin:write", label: "관리 설정 변경", description: "관리 대상과 설정을 변경합니다." },
  { value: "routing:read", label: "라우팅 조회", description: "라우팅 규칙과 상태를 조회합니다." },
  { value: "routing:write", label: "라우팅 변경", description: "라우팅 설정을 변경합니다." },
  {
    value: "observability:read",
    label: "관측 정보 조회",
    description: "요청과 운영 관측 정보를 조회합니다.",
  },
  { value: "costs:read", label: "비용 조회", description: "사용 비용을 조회합니다." },
  { value: "security:read", label: "보안 정보 조회", description: "보안 정보를 조회합니다." },
  { value: "mcp:use", label: "MCP 도구 사용", description: "허용된 MCP 도구를 사용합니다." },
  { value: "mcp:admin", label: "MCP 관리", description: "MCP 관리 기능을 사용합니다." },
  { value: "team:read", label: "팀 조회", description: "팀 정보를 조회합니다." },
] as const;

export const allApiKeyScopes: readonly string[] = apiKeyScopeOptions.map(({ value }) => value);

export function apiKeyScopeChoices(existing: readonly string[]) {
  return [...new Set([...allApiKeyScopes, ...existing])].map((value) => {
    const known = apiKeyScopeOptions.find((option) => option.value === value);
    return {
      value,
      label: known?.label ?? "기타 권한",
      description: `${known?.description ?? "이 화면에 설명이 없는 기존 권한입니다. 해제하지 않으면 그대로 유지합니다."} (${value || "빈 권한 식별자"})`,
    };
  });
}
