import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

interface PanelFailureProps {
  error: unknown;
  hasData: boolean;
  label: string;
  onRetry: () => void;
}

/** Partial failure of one panel: keeps the last good data and offers a retry. */
export function PanelFailure({ error, hasData, label, onRetry }: PanelFailureProps): React.JSX.Element {
  const requestId = isAppError(error) ? error.requestId : undefined;
  return (
    <InlineNotice
      tone="warning"
      title={`${label} ${hasData ? "갱신에 실패해 마지막 정상 데이터를 표시합니다." : "조회에 실패했습니다."}`}
      actions={
        <Button size="small" variant="secondary" onClick={onRetry} aria-label={`${label} 다시 불러오기`}>
          <RefreshCw aria-hidden="true" /> 다시 시도
        </Button>
      }
    >
      {safeAppErrorMessage(error, `${label} 데이터를 확인할 수 없습니다.`)}
      {requestId ? <div className="request-id">요청 ID: {requestId}</div> : null}
    </InlineNotice>
  );
}

/** Read-only preview of text the server already masked; never used for raw secrets. */
export function MaskedText({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rt-masked">
      <div className="rt-masked-label">{label}</div>
      <pre tabIndex={0} aria-label={label}>
        {value === "" ? "(없음)" : value}
      </pre>
    </div>
  );
}

export function FieldRow({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="rt-field-row">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}
