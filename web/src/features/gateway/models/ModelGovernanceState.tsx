import type { PropsWithChildren } from "react";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

export function ModelDraftBoundary({ children }: PropsWithChildren) {
  return useUnsavedChanges() ? <>{children}</> : <UnsavedChangesProvider>{children}</UnsavedChangesProvider>;
}
export function ModelQueryFailure({
  title,
  error,
  retry,
  disabled = false,
}: {
  title: string;
  error: unknown;
  retry: () => void;
  disabled?: boolean;
}) {
  return (
    <InlineNotice tone="danger" title={title}>
      {safeAppErrorMessage(error, "조회 결과를 확인할 수 없습니다. 빈 목록으로 해석하지 마세요.")}
      {isAppError(error) && error.requestId ? (
        <span className="request-id"> 요청 ID: {error.requestId}</span>
      ) : null}
      <Button size="small" variant="ghost" disabled={disabled} onClick={retry}>
        다시 시도
      </Button>
    </InlineNotice>
  );
}
