import type { z } from "zod";
import { apiKeyScopeOptions } from "./api-key-scopes";
import { endpoints } from "@/shared/api/endpoints";

import { roleMatrixSchema } from "@/shared/api/domains/access.schemas";
export { roleMatrixSchema };
export const roleMatrixEndpoint = endpoints.domains.access.roles.matrix;
export type RoleMatrixCatalog = z.output<typeof roleMatrixSchema>;

export function scopeTitle(scope: string): string {
  return apiKeyScopeOptions.find((option) => option.value === scope)?.label ?? "기타 권한";
}

export function matrixRows(
  catalog: RoleMatrixCatalog,
  roles: readonly string[],
  search: string,
  differences: boolean,
) {
  const selected = roles.map((role) => catalog.roles.find((row) => row.role === role));
  const query = search.trim().toLocaleLowerCase();
  return [...new Set([...catalog.all_scopes, ...catalog.roles.flatMap((row) => row.scopes ?? [])])]
    .sort()
    .map((scope) => ({
      scope,
      title: scopeTitle(scope),
      registered: catalog.all_scopes.includes(scope),
      grants: selected.map((role) => role?.scopes?.includes(scope) === true),
    }))
    .filter((row) => `${row.title} ${row.scope}`.toLocaleLowerCase().includes(query))
    .filter((row) => !differences || (row.grants.some(Boolean) && row.grants.some((grant) => !grant)));
}
