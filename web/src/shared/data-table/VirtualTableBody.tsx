import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { Fragment, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { VirtualTableBodyProps } from "./virtual-table-types";

/** Native table rows retain their full content, measured height and current keyboard target. */
export function VirtualTableBody({
  rowKeys,
  columnCount,
  headerRowCount,
  scrollRef,
  layoutVersion,
  renderRow,
}: VirtualTableBodyProps) {
  "use no memo"; // TanStack Virtual v3 mutates its instance; compiler memoization would cache stale ranges.
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string>();
  const getItemKey = useCallback((index: number) => rowKeys[index] ?? index, [rowKeys]);
  const focusedIndex = focusedKey === undefined ? -1 : rowKeys.indexOf(focusedKey);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indices = defaultRangeExtractor(range);
      // Keep a dialog/menu's trigger mounted even when the user scrolls away.
      if (focusedIndex >= 0 && !indices.includes(focusedIndex)) indices.push(focusedIndex);
      return indices.sort((left, right) => left - right);
    },
    [focusedIndex],
  );
  // This component explicitly opts out of compilation above. Keep the mutable instance local.
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual v3 requires a non-memoized component.
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: rowKeys.length,
    getItemKey,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    rangeExtractor,
    scrollMargin: headerHeight,
    scrollPaddingStart: headerHeight,
  });
  useLayoutEffect(() => {
    const header = bodyRef.current?.closest("table")?.tHead;
    if (!header) return;
    const measure = () => setHeaderHeight(header.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, layoutVersion]);
  const pinTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLTableRowElement>("tr[data-table-row-index]");
    if (!row || !bodyRef.current?.contains(row)) return;
    const key = rowKeys[Number(row.dataset.tableRowIndex)];
    if (key !== undefined) setFocusedKey(key);
  };
  const spacer = (key: string, height: number) =>
    height > 0 ? (
      <tr key={key} aria-hidden="true" className="data-table-virtual-spacer">
        <td colSpan={columnCount} style={{ height }} />
      </tr>
    ) : null;
  const content: ReactNode[] = [];
  let end = 0;
  for (const item of virtualizer.getVirtualItems()) {
    const start = Math.max(0, item.start - headerHeight);
    content.push(spacer(`gap-${item.key}`, start - end));
    content.push(
      <Fragment key={`row-${item.key}`}>
        {renderRow(item.index, {
          ref: virtualizer.measureElement,
          "data-index": item.index,
          "aria-rowindex": item.index + headerRowCount + 1,
        })}
      </Fragment>,
    );
    end = Math.max(start, item.end - headerHeight);
  }
  content.push(spacer("end", virtualizer.getTotalSize() - end));
  return (
    <tbody
      ref={bodyRef}
      onFocusCapture={(event) => pinTarget(event.target)}
      onPointerDownCapture={(event) => pinTarget(event.target)}
    >
      {content}
    </tbody>
  );
}
