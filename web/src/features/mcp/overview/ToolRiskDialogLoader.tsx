import type { ComponentProps } from "react";
import { DeferredDialog } from "@/shared/components/ui/DeferredDialog";
import type { ToolRiskDialog } from "./ToolRiskDialog";

const load = () => import("./ToolRiskDialog").then((module) => module.ToolRiskDialog);
export function ToolRiskDialogLoader(props: ComponentProps<typeof ToolRiskDialog>) {
  return (
    <DeferredDialog
      load={load}
      dialogProps={props}
      title="도구 위험 등급 편집"
      onClose={props.onClose}
      returnFocusRef={props.returnFocusRef}
    />
  );
}
