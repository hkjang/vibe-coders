import { validSessionPageValue } from "@/shared/utils/session-page-query";
import type { SessionExplorerQuery } from "@/shared/api/domains/session-page.schema";
import { containsPotentialSecret } from "@/shared/security/secrets";

export function readSessionPage(search: URLSearchParams, prefixes: readonly string[]) {
  const days = search.get("days") ?? "7",
    limit = search.get("page_size") ?? "25",
    offset = search.get("offset") ?? "0",
    q = search.get("q") ?? "";
  const valid =
    ["days", "q", "page_size", "offset"].every((key) => search.getAll(key).length <= 1) &&
    /^(?:[1-9]\d{0,2})$/u.test(days) &&
    Number(days) <= 365 &&
    validSessionPageValue("page_size", [limit]) &&
    validSessionPageValue("offset", [offset]) &&
    Number(offset) % Number(limit) === 0 &&
    new TextEncoder().encode(q).length <= 256 &&
    q.trim() === q &&
    !/[\p{C}]/u.test(q) &&
    !containsPotentialSecret(q, prefixes);
  return {
    valid,
    query: {
      days: Number(days),
      limit: Number(limit) as 25 | 50 | 100,
      offset: Number(offset),
      q: q || undefined,
    } satisfies SessionExplorerQuery,
  };
}
