import type { RefObject } from "react";
import { RedTeamPreflightSummary } from "./RedTeamPreflightSummary";
import type { RedTeamDryRun } from "@/shared/api/domains/redteam";
import { Sheet } from "@/shared/components/ui/Sheet";

export function DryRunSheet({
  onOpenChange,
  preview,
  returnFocusRef,
}: {
  onOpenChange: (open: boolean) => void;
  preview: RedTeamDryRun | undefined;
  returnFocusRef: RefObject<HTMLElement | null>;
}): React.JSX.Element {
  return (
    <Sheet
      open={preview !== undefined}
      onOpenChange={onOpenChange}
      title="사전 점검 결과"
      description="실제 모델 호출 없이 캠페인의 대상·예상 비용·승인 조건을 확인합니다."
      returnFocusRef={returnFocusRef}
      size="wide"
      scrollLabel="사전 점검 결과 내용"
    >
      {preview ? <RedTeamPreflightSummary preview={preview} /> : null}
    </Sheet>
  );
}
