import type { WorkRequestsQuery, WorkSessionsQuery } from "@/shared/api/domains/insights-usage";
import type { WorkQuery } from "@/shared/api/domains/insights-common";
import { workMaxOffset, workStatuses } from "@/shared/api/domains/insights-common";
import type { DataTableSort } from "@/shared/data-table/DataTable";

import { oneOf, pageIndex } from "./usage-filters";
import { completionValues } from "./usage-labels";

// URL state of the 세션·요청 tab: which list, its page, sort and list-only filters.

export const listKinds = ["sessions", "requests"] as const;
export type ListKind = (typeof listKinds)[number];
export const listLabels: Readonly<Record<ListKind, string>> = { sessions: "업무 세션", requests: "요청" };

export const pageSize = 25;

/** Columns the server can order sessions by, with the header each sorts. */
export const sessionSortColumns = [
  { id: "last_at", label: "마지막 활동", initialDirection: "desc" },
  { id: "requests", label: "요청", initialDirection: "desc" },
  { id: "cost_krw", label: "비용", initialDirection: "desc" },
  { id: "duration_ms", label: "소요 시간", initialDirection: "desc" },
  { id: "errors", label: "오류", initialDirection: "desc" },
] as const;
export const defaultSessionSort: DataTableSort = { columnId: "last_at", direction: "desc" };

export const confidenceBands = [
  { id: "low", label: "낮음 (50% 미만)", min: undefined, max: 0.5 },
  { id: "mid", label: "보통 (50~75%)", min: 0.5, max: 0.75 },
  { id: "high", label: "높음 (75% 이상)", min: 0.75, max: undefined },
] as const;
export type ConfidenceBand = (typeof confidenceBands)[number]["id"];

/** `last_at:desc` → a sort the table header shows; anything else is the default. */
export function readSessionSort(value: string | null): DataTableSort {
  const [columnId, direction, extra] = (value ?? "").split(":");
  if (
    extra !== undefined ||
    !sessionSortColumns.some((column) => column.id === columnId) ||
    (direction !== "asc" && direction !== "desc")
  ) {
    return defaultSessionSort;
  }
  return { columnId: columnId as string, direction };
}

export const writeSessionSort = (sort: DataTableSort): string | undefined =>
  sort.columnId === defaultSessionSort.columnId && sort.direction === defaultSessionSort.direction
    ? undefined
    : `${sort.columnId}:${sort.direction}`;

export interface ListState {
  kind: ListKind;
  page: number;
  sort: DataTableSort;
  completion: string;
  status: string;
  confidence: ConfidenceBand | "";
}

export function readListState(params: URLSearchParams): ListState {
  return {
    kind: oneOf(params.get("list"), listKinds, "sessions"),
    page: pageIndex(params.get("page"), pageSize),
    sort: readSessionSort(params.get("sort")),
    completion: oneOf(params.get("session_status"), ["", ...completionValues], ""),
    status: oneOf(params.get("status"), ["", ...workStatuses], ""),
    confidence: oneOf(params.get("conf"), ["", ...confidenceBands.map((band) => band.id)], ""),
  };
}

const paging = (state: ListState): { limit: number; offset: number } => ({
  limit: pageSize,
  offset: state.page * pageSize,
});

export function sessionsQuery(base: WorkQuery, state: ListState): WorkSessionsQuery {
  return {
    ...base,
    ...paging(state),
    sort: `${state.sort.columnId}:${state.sort.direction}`,
    ...(state.completion ? { session_status: state.completion } : {}),
  };
}

export function requestsQuery(base: WorkQuery, state: ListState): WorkRequestsQuery {
  const band = confidenceBands.find((item) => item.id === state.confidence);
  return {
    ...base,
    ...paging(state),
    ...(state.status ? { status: state.status } : {}),
    ...(band?.min !== undefined ? { min_conf: band.min } : {}),
    ...(band?.max !== undefined ? { max_conf: band.max } : {}),
  };
}

/** The last page the server answers: it refuses an offset above `workMaxOffset`. */
export const lastPageIndex = Math.floor(workMaxOffset / pageSize);

/**
 * Pages for a total; at least the current page so "이전" still works past the end,
 * and never a page whose offset the server would refuse (counts stop at 100,000).
 */
export function pageCount(total: number | undefined, page: number): number {
  const pages = total === undefined ? page + 1 : Math.max(1, Math.ceil(total / pageSize), page + 1);
  return Math.min(pages, lastPageIndex + 1);
}
