import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export function LabReadError({ error, title, retry }: { error: unknown; title: string; retry: () => void }) {
  return (
    <InlineNotice tone="danger" title={title}>
      <p>{safeAppErrorMessage(error, "권한 또는 네트워크 상태를 확인하세요.")}</p>
      {isAppError(error) && error.requestId ? <p>요청 ID: {error.requestId}</p> : null}
      <Button size="small" variant="ghost" onClick={retry}>
        다시 시도
      </Button>
    </InlineNotice>
  );
}
