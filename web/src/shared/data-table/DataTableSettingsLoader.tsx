import { useEffect, useState, type ComponentType } from "react";
import type { DataTableSettingsDialogProps } from "./DataTableSettingsDialog";
import { cancelPendingTool } from "./cancel-pending-tool";

/** Mount only while open; moving away during download cancels the pending dialog. */
export function DataTableSettingsLoader(props: DataTableSettingsDialogProps) {
  const [Dialog, setDialog] = useState<ComponentType<DataTableSettingsDialogProps>>();
  const [failed, setFailed] = useState(false);
  const { onOpenChange } = props;
  useEffect(() => {
    let active = true;
    void import("./DataTableSettingsDialog")
      .then((module) => {
        if (active) setDialog(() => module.DataTableSettingsDialog);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (Dialog) return;
    return cancelPendingTool(() => onOpenChange(false));
  }, [Dialog, onOpenChange]);
  if (Dialog) return <Dialog {...props} />;
  return (
    <p role="status">
      {failed
        ? "열 설정을 불러오지 못했습니다. 화면을 새로고침한 뒤 다시 시도하세요."
        : "열 설정을 불러오는 중입니다."}
    </p>
  );
}
