import type { AccountQuery } from "@/shared/api/domains/account-page.schemas";
import type { DataTableSort } from "@/shared/data-table/DataTable";
import { containsPotentialSecret } from "@/shared/security/secrets";

export const accountSortColumns = [
  { id: "email", label: "이메일" },
  { id: "name", label: "이름" },
  { id: "role", label: "역할" },
  { id: "status", label: "상태" },
  { id: "team_name", label: "팀 이름" },
  { id: "created_at", label: "생성 시각" },
] as const;
export function validAccountText(value: string, prefixes: readonly string[], limit = 200) {
  return (
    [...value].length <= limit &&
    new TextEncoder().encode(value).length <= (limit === 200 ? 800 : 256) &&
    !/\p{C}/u.test(value) &&
    !containsPotentialSecret(value, prefixes)
  );
}
export function readAccountPage(params: URLSearchParams, prefixes: readonly string[]) {
  const safe = (key: string, limit = 200) => {
    const value = params.get(key)?.trim() ?? "";
    return validAccountText(value, prefixes, limit) ? value : "";
  };
  const search = safe("account_q"),
    role = safe("account_role", 256);
  const status = ["active", "disabled"].includes(safe("account_status")) ? safe("account_status") : "";
  const rawTeam = params.get("account_team") ?? "";
  const team =
    rawTeam === "none"
      ? "none"
      : rawTeam.startsWith("id:") && rawTeam.length > 3 && validAccountText(rawTeam.slice(3), prefixes, 256)
        ? rawTeam
        : "";
  const size = [10, 25, 50].find((size) => String(size) === params.get("account_size")) ?? 25;
  const rawPage = Number(params.get("account_page"));
  const page =
    Number.isSafeInteger(rawPage) && rawPage >= 1 && (rawPage - 1) * size <= 1_000_000 ? rawPage - 1 : 0;
  const parts = (params.get("account_sort") ?? "").split(",").filter(Boolean);
  const sorts: DataTableSort[] = [];
  for (const part of parts) {
    const [id, direction, extra] = part.split(":");
    if (
      parts.length > 3 ||
      !id ||
      extra !== undefined ||
      !accountSortColumns.some((column) => column.id === id) ||
      !["asc", "desc"].includes(direction ?? "") ||
      sorts.some((sort) => sort.columnId === id)
    ) {
      sorts.length = 0;
      break;
    }
    sorts.push({ columnId: id, direction: direction === "desc" ? "desc" : "asc" });
  }
  const query: AccountQuery = {
    view: "accounts",
    limit: size,
    offset: page * size,
    ...(search ? { q: search } : {}),
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
    ...(team ? { team_id: team === "none" ? "" : team.slice(3) } : {}),
    ...(sorts.length ? { sort: sorts.map((row) => `${row.columnId}:${row.direction}`).join(",") } : {}),
  };
  return { search, role, status, team, size, page, sorts, query };
}
export type AccountPageState = ReturnType<typeof readAccountPage>;
