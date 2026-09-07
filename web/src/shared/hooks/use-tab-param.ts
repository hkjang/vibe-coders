import { useCallback } from "react";

import { useSearchState } from "@/shared/hooks/use-search-state";

/**
 * Tab selection stored in `?tab=`; unknown values fall back to the first tab so a
 * stale link still opens the screen.
 */
export function useTabParam<Id extends string>(
  ids: readonly Id[],
  fallback: Id = ids[0] as Id,
  key = "tab",
): [Id, (id: Id) => void] {
  const [params, update] = useSearchState();
  const requested = params.get(key);
  const value = (ids as readonly string[]).includes(requested ?? "") ? (requested as Id) : fallback;
  const setValue = useCallback(
    (id: Id): void => update({ [key]: id === fallback ? undefined : id }),
    [fallback, key, update],
  );
  return [value, setValue];
}
