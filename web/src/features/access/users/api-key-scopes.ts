import { permissionScopeOptions } from "@/config/permission-scopes";

export const apiKeyScopeOptions = permissionScopeOptions;

export const allApiKeyScopes: readonly string[] = apiKeyScopeOptions.map(({ value }) => value);

export function apiKeyScopeChoices(existing: readonly string[]) {
  return [...new Set([...allApiKeyScopes, ...existing])].map((value) => {
    const known = apiKeyScopeOptions.find((option) => option.value === value);
    return {
      value,
      label: known?.label ?? "기타 권한",
      description: `${known?.description ?? "이 화면에 설명이 없는 기존 권한입니다. 선택을 유지하면 이 값을 함께 전송하며, 허용 여부는 서버가 검증합니다."} (${value || "빈 권한 식별자"})`,
    };
  });
}
