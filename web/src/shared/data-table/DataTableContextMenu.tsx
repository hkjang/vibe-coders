import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { TableRowMenuProps } from "./TableRowMenu";
import { cancelPendingTool } from "./cancel-pending-tool";
import { interactiveRowTarget } from "./row-interaction";

interface Row<TData> {
  id: string;
  original: TData;
}
interface Selection<TData> {
  row: Row<TData>;
  button: HTMLButtonElement;
  x: number;
  y: number;
}
interface Props<TData> {
  children: ReactNode;
  enabled: boolean;
  rows: readonly Row<TData>[];
  getActionLabel?: (row: TData) => string;
  onAction?: (row: TData) => void;
}

/** A single existing row action; the native top layer avoids clipping in scrollable tables. */
export function DataTableContextMenu<TData>({
  children,
  enabled,
  rows,
  getActionLabel,
  onAction,
}: Props<TData>) {
  const host = useRef<HTMLDivElement>(null);
  const [Menu, setMenu] = useState<ComponentType<TableRowMenuProps>>();
  const [failed, setFailed] = useState(false);
  const [selection, setSelection] = useState<Selection<TData>>();
  const current =
    selection && enabled && onAction && getActionLabel
      ? rows.find((row) => row.id === selection.row.id && row.original === selection.row.original)
      : undefined;
  // Invalidate immediately; a later response must not revive an obsolete action.
  if (selection && !current) setSelection(undefined);

  useEffect(() => {
    if (!selection || Menu) return;
    let active = true;
    void import("./TableRowMenu")
      .then((module) => {
        if (active) setMenu(() => module.TableRowMenu);
      })
      .catch(() => {
        if (active) {
          setFailed(true);
          setSelection(undefined);
        }
      });
    // A delayed asset must never open after the user has moved elsewhere.
    const cleanup = cancelPendingTool(() =>
      setSelection((value) => (value === selection ? undefined : value)),
    );
    return () => {
      active = false;
      cleanup();
    };
  }, [selection, Menu]);

  const targetRow = (target: EventTarget | null): Omit<Selection<TData>, "x" | "y"> | undefined => {
    if (
      !enabled ||
      !onAction ||
      !getActionLabel ||
      !(target instanceof Element) ||
      !host.current?.contains(target)
    )
      return;
    if (typeof host.current.showPopover !== "function") return;
    const element = target.closest<HTMLTableRowElement>("tr[data-table-row-index]");
    if (!element || interactiveRowTarget(target, element, true)) return;
    if (target.closest("table") !== host.current.querySelector("table")) return;
    const index = Number(element?.dataset.tableRowIndex);
    const row = Number.isInteger(index) && index >= 0 ? rows[index] : undefined;
    const button = element?.querySelector<HTMLButtonElement>("button[data-table-row-action]");
    if (row && button && !button.disabled) return { row, button };
  };

  return (
    <div
      ref={host}
      tabIndex={-1}
      style={{ minWidth: 0 }}
      onContextMenu={(event) => {
        const next = targetRow(event.target);
        if (!next || document.getSelection()?.toString()) return;
        event.preventDefault();
        event.stopPropagation();
        setFailed(false);
        setSelection({ ...next, x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
        if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
        const next = targetRow(event.target);
        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        setFailed(false);
        const bounds = next.button.getBoundingClientRect();
        setSelection({ ...next, x: bounds.left, y: bounds.bottom });
      }}
    >
      {children}
      {current && selection && Menu ? (
        <Menu
          x={selection.x}
          y={selection.y}
          returnTo={selection.button}
          label={getActionLabel?.(current.original) ?? "상세 보기"}
          onClose={() => setSelection((value) => (value === selection ? undefined : value))}
          onAction={() => {
            flushSync(() => setSelection(undefined));
            selection.button.focus();
            onAction?.(current.original);
          }}
        />
      ) : null}
      {selection && !Menu ? (
        <span role="status" className="sr-only">
          행 메뉴를 불러오는 중입니다.
        </span>
      ) : null}
      {failed ? (
        <span role="status">행 메뉴를 불러오지 못했습니다. 행의 상세 버튼을 이용해 주세요.</span>
      ) : null}
    </div>
  );
}
