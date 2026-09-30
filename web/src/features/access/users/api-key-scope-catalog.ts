import type { z } from "zod";

import type { adminRolesSchema } from "@/shared/api/domains/access.schemas";

export type ApiKeyRoleCatalog = z.output<typeof adminRolesSchema>;

interface CatalogState {
  status: "pending" | "error" | "success";
  fetchStatus: "fetching" | "paused" | "idle";
  data?: ApiKeyRoleCatalog;
  isInvalidated?: boolean;
}

export function confirmedScopeCatalog(state: CatalogState | undefined): readonly string[] | undefined {
  if (!state || state.status !== "success" || state.fetchStatus !== "idle" || state.isInvalidated) {
    return undefined;
  }
  const scopes = state.data?.all_scopes;
  // This endpoint always returns a nonempty catalog. The legacy adapter also
  // maps an absent field to [], which must not be mistaken for a verified list.
  return scopes && scopes.length > 0 && scopes.every((scope) => scope.trim() !== "") ? scopes : undefined;
}

export function unsupportedSelectedScopes(selected: readonly string[], catalog: readonly string[]): string[] {
  return [...new Set(selected.filter((scope) => !catalog.includes(scope)))];
}
