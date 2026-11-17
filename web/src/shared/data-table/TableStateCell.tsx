import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Keep state semantics in the table, with content sized to its scroll viewport. */
export function TableStateCell({
  children,
  colSpan,
  error = false,
}: {
  children: ReactNode;
  colSpan: number;
  error?: boolean;
}) {
  const cell = useRef<HTMLTableCellElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = cell.current?.closest<HTMLElement>(".data-table-scroll");
    if (!viewport) return;
    const measure = () => {
      if (viewport.clientWidth > 0)
        content.current?.style.setProperty("--data-table-state-width", `${viewport.clientWidth}px`);
    };
    measure();
    const Observer = globalThis.ResizeObserver;
    const observer = typeof Observer === "function" ? new Observer(measure) : undefined;
    observer?.observe(viewport);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return (
    <td
      ref={cell}
      colSpan={colSpan}
      className={error ? "data-table-state data-table-error" : "data-table-state"}
    >
      <div ref={content} className="data-table-state-content" role={error ? "alert" : undefined}>
        {children}
      </div>
    </td>
  );
}
