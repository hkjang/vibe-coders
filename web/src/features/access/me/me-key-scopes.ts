import type { z } from "zod";

import { apiKeyScopeOptions } from "@/features/access/users/api-key-scopes";
import type { meKeysSchema } from "@/shared/api/domains/access.schemas";

export type MeKeyCatalog = z.output<typeof meKeysSchema>;

interface CatalogState {
  status: "pending" | "error" | "success";
  fetchStatus: "fetching" | "paused" | "idle";
  data?: MeKeyCatalog;
  isInvalidated?: boolean;
}

export function confirmedMeScopeCatalog(state: CatalogState | undefined): readonly string[] | undefined {
  if (!state || state.status !== "success" || state.fetchStatus !== "idle" || state.isInvalidated) {
    return undefined;
  }
  const scopes = state.data?.grantable_scopes;
  // A caller may legitimately have no grantable permissions. Missing/null is
  // deliberately preserved by the personal API adapter instead of defaulting to [].
  return scopes?.every((scope) => scope.trim() !== "") ? scopes : undefined;
}

export function ungrantableMeScopes(selected: readonly string[], catalog: readonly string[]): string[] {
  return [...new Set(selected.filter((scope) => !catalog.includes(scope)))];
}

export function meKeyScopeChoices(values: readonly string[]) {
  // Reuse label metadata only, never the admin picker's always-present options.
  return [...new Set(values)].map((value) => {
    const known = apiKeyScopeOptions.find((option) => option.value === value);
    return {
      value,
      label: known?.label ?? "기타 권한",
      description: `${known?.description ?? "이 화면에 설명이 없는 권한입니다. 기존 선택은 임의로 제거하지 않으며, 허용 여부는 서버가 검증합니다."} (${value || "빈 권한 식별자"})`,
    };
  });
}
