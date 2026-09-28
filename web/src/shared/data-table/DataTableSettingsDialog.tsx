import { ArrowLeft, ArrowRight, RotateCcw } from "lucide-react";
import type { RefObject } from "react";

import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import type { DataTableSettingsColumn } from "@/shared/data-table/use-data-table-layout";

interface DataTableSettingsDialogProps {
  announcement: string;
  columns: readonly DataTableSettingsColumn[];
  onMove: (columnId: string, direction: -1 | 1) => void;
  onOpenChange: (open: boolean) => void;
  onReset: () => void;
  onToggleVisibility: (columnId: string, visible: boolean) => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export function DataTableSettingsDialog({
  announcement,
  columns,
  onMove,
  onOpenChange,
  onReset,
  onToggleVisibility,
  open,
  returnFocusRef,
}: DataTableSettingsDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      title="표 열 설정"
      description="표시할 열과 순서를 정합니다. 머리글 경계를 드래그하거나 키보드 화살표로 너비를 조절할 수 있습니다."
      footer={
        <>
          <Button variant="secondary" onClick={onReset}>
            <RotateCcw aria-hidden="true" /> 기본값으로 초기화
          </Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            설정 완료
          </Button>
        </>
      }
    >
      <div className="data-table-settings-list">
        {columns.map((column) => (
          <div className="data-table-settings-row" key={column.id}>
            <Checkbox
              checked={column.visible}
              disabled={column.disabledVisibility}
              label={column.label}
              description={
                column.locked
                  ? "항상 표시되는 필수 열"
                  : column.disabledVisibility
                    ? "표에는 열이 하나 이상 필요합니다."
                    : `${column.width}px`
              }
              onChange={(event) => onToggleVisibility(column.id, event.currentTarget.checked)}
            />
            <div className="data-table-order-actions">
              <Button
                size="icon"
                variant="ghost"
                disabled={!column.canMoveLeft}
                aria-label={`${column.label} 열을 왼쪽으로 이동`}
                onClick={() => onMove(column.id, -1)}
              >
                <ArrowLeft aria-hidden="true" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                disabled={!column.canMoveRight}
                aria-label={`${column.label} 열을 오른쪽으로 이동`}
                onClick={() => onMove(column.id, 1)}
              >
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))}
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </Dialog>
  );
}
