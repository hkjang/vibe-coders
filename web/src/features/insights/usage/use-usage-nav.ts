import { useMemo } from "react";

import { useSearchState, type SearchUpdates } from "@/shared/hooks/use-search-state";

import { drillTarget } from "./drill-path";

export interface UsageNav {
  /** Query string of this screen with `updates` applied, for a link. */
  search: (updates: SearchUpdates) => string;
  /** Applies `updates` as a new history entry, so Back returns to the current view. */
  go: (updates: SearchUpdates) => void;
  /** Follows a breakdown row: into its children, or to its sessions at a leaf. */
  selectCategory: (row: { id: string; hasChildren: boolean }) => void;
}

/** Leaving a list resets its paging and list-only filters, so a new view starts clean. */
const listReset = {
  page: undefined,
  sort: undefined,
  status: undefined,
  conf: undefined,
  session_status: undefined,
  session: undefined,
} as const;

export function categoryUpdates(row: { id: string; hasChildren: boolean }): SearchUpdates {
  const target = drillTarget(row);
  if (target.kind === "children") return { tab: "categories", parent: target.parent };
  if (target.kind === "requests") {
    return { ...listReset, tab: "sessions", list: "requests", status: target.status, parent: undefined };
  }
  return { ...listReset, tab: "sessions", list: undefined, category: target.category, parent: undefined };
}

export function sessionsUpdates(filters: {
  team?: string;
  category?: string;
  model?: string;
}): SearchUpdates {
  return { ...listReset, tab: "sessions", list: undefined, parent: undefined, ...filters };
}

export function useUsageNav(): UsageNav {
  const [params, update] = useSearchState();
  return useMemo(
    () => ({
      search: (updates) => {
        const next = new URLSearchParams(params);
        for (const [key, raw] of Object.entries(updates)) {
          const value = raw === undefined || raw === null ? "" : String(raw);
          if (value === "") next.delete(key);
          else next.set(key, value);
        }
        const text = next.toString();
        return text ? `?${text}` : "";
      },
      go: (updates) => update(updates, { replace: false }),
      selectCategory: (row) => update(categoryUpdates(row), { replace: false }),
    }),
    [params, update],
  );
}
