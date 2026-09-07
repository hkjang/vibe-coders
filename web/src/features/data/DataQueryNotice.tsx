import { RefreshCw } from "lucide-react";

import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

interface DataQueryNoticeProps {
  error: unknown;
  /** Keep the last good data on screen and downgrade the message to a warning. */
  hasPreviousData: boolean;
  label: string;
  onRetry: () => void;
}

/** Partial-failure banner for one panel; the rest of the screen keeps working. */
export function DataQueryNotice({
  error,
  hasPreviousData,
  label,
  onRetry,
}: DataQueryNoticeProps): React.JSX.Element {
  const requestId = isAppError(error) ? error.requestId : undefined;
  return (
    <InlineNotice
      tone={hasPreviousData ? "warning" : "danger"}
      title={
        hasPreviousData
          ? `${label} 갱신에 실패해 마지막 정상 데이터를 표시합니다.`
          : `${label}을(를) 불러오지 못했습니다.`
      }
      actions={
        <Button size="small" variant="secondary" onClick={onRetry} aria-label={`${label} 다시 시도`}>
          <RefreshCw aria-hidden="true" /> 다시 시도
        </Button>
      }
    >
      <p>{safeAppErrorMessage(error, `${label} 데이터를 확인할 수 없습니다.`)}</p>
      {requestId ? <p className="request-id">요청 ID: {requestId}</p> : null}
    </InlineNotice>
  );
}
