import type { WorkAppPageQuery } from "@/shared/api/domains/work-app-page.schemas";
import type { DataTableSort } from "@/shared/data-table/DataTable";
import { containsPotentialSecret } from "@/shared/security/secrets";

export const workAppSortColumns = [
  { id: "title", label: "이름" },
  { id: "owner", label: "책임자" },
  { id: "status", label: "상태" },
  { id: "created_at", label: "생성 시각" },
  { id: "updated_at", label: "수정 시각" },
  { id: "id", label: "ID" },
] as const;
export function validWorkAppSearch(value: string, prefixes: readonly string[]) {
  return (
    [...value].length <= 200 &&
    new TextEncoder().encode(value).length <= 800 &&
    !/\p{C}/u.test(value) &&
    !containsPotentialSecret(value, prefixes)
  );
}
export function validWorkAppDetailId(value: string, prefixes: readonly string[]) {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 4096 &&
    !/\p{C}/u.test(value) &&
    !containsPotentialSecret(value, prefixes)
  );
}
export function readWorkAppPage(params: URLSearchParams, prefixes: readonly string[]) {
  const raw = params.get("q")?.trim() ?? "";
  const search = validWorkAppSearch(raw, prefixes) ? raw : "";
  const rawStatus = params.get("status");
  const status = rawStatus === "active" || rawStatus === "archived" ? rawStatus : "all";
  const size = [10, 25, 50].find((value) => String(value) === params.get("size")) ?? 25;
  const number = Number(params.get("page"));
  const page =
    Number.isSafeInteger(number) && number >= 1 && (number - 1) * size <= 1_000_000 ? number - 1 : 0;
  const parts = (params.get("sort") ?? "").split(",").filter(Boolean);
  const sorts: DataTableSort[] = [];
  for (const part of parts) {
    const [columnId, direction, extra] = part.split(":");
    if (
      parts.length > 3 ||
      extra !== undefined ||
      !columnId ||
      !workAppSortColumns.some((column) => column.id === columnId) ||
      (direction !== "asc" && direction !== "desc") ||
      sorts.some((sort) => sort.columnId === columnId)
    ) {
      sorts.length = 0;
      break;
    }
    sorts.push({ columnId, direction });
  }
  const query: WorkAppPageQuery = {
    view: "page",
    limit: size,
    offset: page * size,
    ...(search ? { q: search } : {}),
    ...(status !== "all" ? { status } : {}),
    ...(sorts.length ? { sort: sorts.map((item) => `${item.columnId}:${item.direction}`).join(",") } : {}),
  };
  return { search, status, size, page, sorts, query };
}
export type WorkAppPageState = ReturnType<typeof readWorkAppPage>;
