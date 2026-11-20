const labels: Readonly<Record<string, string>> = {
  "env.auth_enabled": "계정 인증 사용",
  "env.auth_access_token_ttl": "접근 토큰 유효기간",
  "env.auth_refresh_token_ttl": "갱신 토큰 유효기간",
  "env.auth_jwt_configured": "JWT 서명 키 설정 여부",
  "env.self_service_keys_enabled": "개인 API 키 관리 허용",
};

export function settingLabel(key: string): string {
  return labels[key] ?? key;
}

export function settingCategoryLabel(category: string): string {
  return category === "env.auth" ? "인증 · 시작 환경" : category;
}

export function startupAuthenticationValue(key: string, value: string): string | undefined {
  if (!(key in labels)) return undefined;
  if (key === "env.auth_jwt_configured")
    return value === "true" ? "설정됨" : value === "false" ? "미설정" : value;
  if (value === "true") return "사용함";
  if (value === "false") return "사용 안 함";
  return value;
}
