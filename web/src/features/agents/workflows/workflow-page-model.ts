import type { WorkflowPageQuery } from "@/shared/api/domains/workflow-page.schemas";
import type { DataTableSort } from "@/shared/data-table/DataTable";
import { containsPotentialSecret } from "@/shared/security/secrets";

export const workflowSortColumns = [
  { id: "name", label: "이름" },
  { id: "allowed_teams", label: "허용 팀" },
  { id: "enabled", label: "상태" },
  { id: "created_at", label: "생성 시각" },
  { id: "updated_at", label: "수정 시각" },
  { id: "id", label: "ID" },
] as const;
export function validWorkflowSearch(value: string, prefixes: readonly string[]) {
  return (
    [...value].length <= 200 &&
    new TextEncoder().encode(value).length <= 800 &&
    !/\p{C}/u.test(value) &&
    !containsPotentialSecret(value, prefixes)
  );
}
export function validWorkflowDetailId(value: string, prefixes: readonly string[]) {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 4096 &&
    !/\p{C}/u.test(value) &&
    !containsPotentialSecret(value, prefixes)
  );
}
export function readWorkflowPage(params: URLSearchParams, prefixes: readonly string[]) {
  const raw = params.get("q")?.trim() ?? "";
  const search = validWorkflowSearch(raw, prefixes) ? raw : "";
  const rawStatus = params.get("status");
  const status = rawStatus === "enabled" || rawStatus === "disabled" ? rawStatus : "all";
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
      !workflowSortColumns.some((column) => column.id === columnId) ||
      (direction !== "asc" && direction !== "desc") ||
      sorts.some((sort) => sort.columnId === columnId)
    ) {
      sorts.length = 0;
      break;
    }
    sorts.push({ columnId, direction });
  }
  const query: WorkflowPageQuery = {
    view: "page",
    limit: size,
    offset: page * size,
    ...(search ? { q: search } : {}),
    ...(status !== "all" ? { status } : {}),
    ...(sorts.length ? { sort: sorts.map((item) => `${item.columnId}:${item.direction}`).join(",") } : {}),
  };
  return { search, status, size, page, sorts, query };
}
export type WorkflowPageState = ReturnType<typeof readWorkflowPage>;
