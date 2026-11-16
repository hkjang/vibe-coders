import { GripVertical } from "lucide-react";
import type { MouseEventHandler, TouchEventHandler } from "react";
import { maximumDataTableColumnWidth, minimumDataTableColumnWidth } from "./table-preferences";

export function DataTableResizeHandle({
  label,
  width,
  onReset,
  onKey,
  onMouseDown,
  onTouchStart,
}: {
  label: string;
  width: number;
  onReset: () => void;
  onKey: (key: string) => boolean;
  onMouseDown: MouseEventHandler<HTMLDivElement>;
  onTouchStart: TouchEventHandler<HTMLDivElement>;
}): React.JSX.Element {
  return (
    <div
      className="data-table-resizer"
      role="separator"
      tabIndex={0}
      aria-label={`${label} 열 너비 조절`}
      aria-orientation="vertical"
      aria-valuemax={maximumDataTableColumnWidth}
      aria-valuemin={minimumDataTableColumnWidth}
      aria-valuenow={Math.round(width)}
      title="드래그하거나 왼쪽·오른쪽 화살표로 너비 조절"
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (onKey(event.key)) event.preventDefault();
      }}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
    >
      <GripVertical aria-hidden="true" />
    </div>
  );
}
