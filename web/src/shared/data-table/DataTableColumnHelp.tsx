import { Info } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { ColumnTooltipProps } from "./ColumnTooltip";
import { cancelPendingTool } from "./cancel-pending-tool";
import type { DataTableColumnHelp as Help } from "./columns";

/** Static column semantics only. Never receives or persists row values. */
export interface DataTableHeaderContentProps {
  children: ReactNode;
  label: string;
  help?: Help;
}

export function DataTableHeaderContent({ children, label, help }: DataTableHeaderContentProps) {
  return (
    <span
      className={help ? "data-table-header-content data-table-header-with-help" : "data-table-header-content"}
    >
      {help ? (
        <>
          <span className="data-table-heading-label">
            {children}
            {help.unit ? ` (${help.unit})` : ""}
          </span>
          <ColumnHelp label={label} help={help} />
        </>
      ) : (
        children
      )}
    </span>
  );
}

function ColumnHelp({ label, help }: { label: string; help: Help }) {
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const [Tooltip, setTooltip] = useState<ComponentType<ColumnTooltipProps> | null>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activity = useRef({ focused: false, hovered: false, pinned: false });
  const [open, setOpen] = useState(false);
  const enter = (field: "focused" | "hovered") => {
    clearTimeout(timer.current);
    activity.current[field] = true;
    setOpen(true);
  };
  const close = useCallback(() => {
    clearTimeout(timer.current);
    activity.current.pinned = false;
    setOpen(false);
  }, []);
  const leave = (field: "focused" | "hovered") => {
    activity.current[field] = false;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!Object.values(activity.current).some(Boolean)) setOpen(false);
    }, 150);
  };
  useLayoutEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open || Tooltip !== undefined) return;
    let active = true;
    void import("./ColumnTooltip")
      .then((module) => {
        if (active) setTooltip(() => module.ColumnTooltip);
      })
      .catch(() => {
        if (active) setTooltip(null);
      });
    const cancel = cancelPendingTool(close);
    return () => {
      active = false;
      cancel();
    };
  }, [open, Tooltip, close]);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="data-table-help-button"
        aria-label={`${label} 열 설명`}
        aria-describedby={open ? id : undefined}
        title={Tooltip === null ? help.description : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          enter("hovered");
        }}
        onPointerLeave={() => leave("hovered")}
        onFocus={() => enter("focused")}
        onBlur={() => leave("focused")}
        onClick={() => {
          if (activity.current.pinned) close();
          else {
            clearTimeout(timer.current);
            activity.current.pinned = true;
            setOpen(true);
          }
        }}
      >
        <Info aria-hidden="true" />
      </button>
      {open && Tooltip ? (
        <Tooltip
          anchor={anchor}
          id={id}
          label={label}
          help={help}
          onClose={close}
          onEnter={() => enter("hovered")}
          onLeave={() => leave("hovered")}
        />
      ) : open ? (
        <span className="sr-only" id={id} role="tooltip">
          {help.description}
        </span>
      ) : null}
    </>
  );
}
