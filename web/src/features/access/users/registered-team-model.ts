import type { RegisteredTeamQuery } from "@/shared/api/domains/team-page.schemas";
import type { DataTableSort } from "@/shared/data-table/DataTable";
import { containsPotentialSecret } from "@/shared/security/secrets";

export const registeredTeamSortColumns = [
  { id: "name", label: "팀 이름" },
  { id: "id", label: "팀 ID" },
  { id: "created_at", label: "생성 시각" },
  { id: "updated_at", label: "수정 시각" },
] as const;
export function validTeamSearch(value: string, prefixes: readonly string[]) {
  return [...value].length <= 200 && !/\p{C}/u.test(value) && !containsPotentialSecret(value, prefixes);
}
export function readRegisteredTeamPage(params: URLSearchParams, prefixes: readonly string[]) {
  const input = params.get("registered_q")?.trim() ?? "";
  const search = validTeamSearch(input, prefixes) ? input : "";
  const size = [10, 25, 50].find((size) => String(size) === params.get("registered_size")) ?? 25;
  const rawPage = Number(params.get("registered_page"));
  const page =
    Number.isSafeInteger(rawPage) && rawPage >= 1 && (rawPage - 1) * size <= 1_000_000 ? rawPage - 1 : 0;
  const parts = (params.get("registered_sort") ?? "").split(",").filter(Boolean);
  const sorts: DataTableSort[] = [];
  for (const part of parts) {
    const [id, direction, extra] = part.split(":");
    if (
      parts.length > 3 ||
      !id ||
      extra !== undefined ||
      !registeredTeamSortColumns.some((column) => column.id === id) ||
      !["asc", "desc"].includes(direction ?? "") ||
      sorts.some((sort) => sort.columnId === id)
    ) {
      sorts.length = 0;
      break;
    }
    sorts.push({ columnId: id, direction: direction === "desc" ? "desc" : "asc" });
  }
  const query: RegisteredTeamQuery = {
    view: "registered",
    limit: size,
    offset: page * size,
    ...(search ? { q: search } : {}),
    ...(sorts.length ? { sort: sorts.map((row) => `${row.columnId}:${row.direction}`).join(",") } : {}),
  };
  return { search, size, page, sorts, query };
}
export type RegisteredTeamState = ReturnType<typeof readRegisteredTeamPage>;
