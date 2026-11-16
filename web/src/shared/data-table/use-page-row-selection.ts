import { useLayoutEffect, useMemo, useRef, useState } from "react";

/** Selection belongs to one received page and is never persisted across responses. */
export function usePageRowSelection<Row>(
  frame: object,
  rows: readonly Row[],
  identity: (row: Row) => string,
  isPageCurrent: () => boolean,
) {
  const [selection, setSelection] = useState({ frame, ids: new Set<string>() });
  if (selection.frame !== frame) setSelection({ frame, ids: new Set<string>() });
  const ids = selection.frame === frame ? selection.ids : new Set<string>();
  const binding = useMemo(() => ({ frame, selection }), [frame, selection]);
  const active = useRef<typeof binding | undefined>(undefined);
  useLayoutEffect(() => {
    active.current = binding;
    return () => {
      if (active.current === binding) active.current = undefined;
    };
  }, [binding]);
  const current = () => active.current === binding && selection.frame === frame && isPageCurrent();
  const selectedRows = rows.filter((row) => ids.has(identity(row)));
  const update = (next: Set<string>) => {
    if (!current()) return;
    // Retire callbacks immediately, including a second call before React commits.
    active.current = undefined;
    setSelection({ frame, ids: next });
  };
  return {
    count: selectedRows.length,
    selectedRows,
    all: rows.length > 0 && selectedRows.length === rows.length,
    mixed: selectedRows.length > 0 && selectedRows.length < rows.length,
    has: (row: Row) => ids.has(identity(row)),
    toggle: (row: Row) => {
      if (!rows.includes(row)) return;
      const next = new Set(ids);
      const id = identity(row);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      update(next);
    },
    toggleAll: () => update(selectedRows.length === rows.length ? new Set() : new Set(rows.map(identity))),
    clear: () => update(new Set()),
    isCurrent: current,
  };
}
