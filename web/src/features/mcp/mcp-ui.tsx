import { RefreshCw } from "lucide-react";

import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

/** Partial failure banner: keeps the last good data on screen and offers a retry. */
export function QueryNotice({
  error,
  hasData,
  label,
  onRetry,
}: {
  error: unknown;
  hasData: boolean;
  label: string;
  onRetry: () => void;
}): React.JSX.Element {
  const requestId = isAppError(error) ? error.requestId : undefined;
  return (
    <InlineNotice
      tone={hasData ? "warning" : "danger"}
      title={`${label} ${hasData ? "갱신에 실패해 마지막 정상 데이터를 표시합니다." : "조회에 실패했습니다."}`}
      actions={
        <Button size="small" onClick={onRetry} aria-label={`${label} 다시 시도`}>
          <RefreshCw aria-hidden="true" /> 다시 시도
        </Button>
      }
    >
      <p>{safeAppErrorMessage(error, `${label} 데이터를 확인할 수 없습니다.`)}</p>
      {requestId ? <span className="request-id">요청 ID: {requestId}</span> : null}
    </InlineNotice>
  );
}
