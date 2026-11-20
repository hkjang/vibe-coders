import type { ComponentProps } from "react";
import { DeferredDialog } from "@/shared/components/ui/DeferredDialog";
import type { UpstreamFormDialog } from "./UpstreamFormDialog";

const load = () => import("./UpstreamFormDialog").then((module) => module.UpstreamFormDialog);
export function UpstreamFormDialogLoader(props: ComponentProps<typeof UpstreamFormDialog>) {
  return (
    <DeferredDialog
      load={load}
      dialogProps={props}
      title={props.upstream ? "업스트림 편집" : "업스트림 등록"}
      onClose={() => props.onOpenChange(false)}
      returnFocusRef={props.returnFocusRef}
    />
  );
}
