import type { ReactNode } from "react";

import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime } from "@/shared/utils/format";

interface QueryNoticeProps {
  error: unknown;
  hasPreviousData: boolean;
  label: string;
  onRetry: () => void;
}

/**
 * Partial-failure banner: keeps the last good data on screen and always shows the
 * request ID so an operator can quote it.
 */
export function QueryNotice({ error, hasPreviousData, label, onRetry }: QueryNoticeProps): React.JSX.Element {
  const requestId = isAppError(error) ? error.requestId : undefined;
  return (
    <InlineNotice
      tone={hasPreviousData ? "warning" : "danger"}
      title={`${label}을(를) 불러오지 못했습니다.`}
      actions={
        <Button size="small" onClick={onRetry}>
          다시 시도
        </Button>
      }
    >
      <p>{safeAppErrorMessage(error, "잠시 후 다시 시도해 주세요.")}</p>
      {hasPreviousData ? <p>마지막으로 확인된 값을 표시하고 있습니다.</p> : null}
      {requestId ? <p className="request-id">요청 ID: {requestId}</p> : null}
    </InlineNotice>
  );
}

export function UpdatedAt({ at }: { at: number | undefined }): React.JSX.Element | null {
  if (!at) return null;
  return (
    <p className="updated-at" role="status">
      마지막 갱신 {formatDateTime(at)}
    </p>
  );
}

interface WriteGateProps {
  children: ReactNode;
  reason: string | undefined;
}

/** Explains, next to the disabled controls, why writing is not available. */
export function WriteGate({ children, reason }: WriteGateProps): React.JSX.Element {
  return (
    <>
      {children}
      {reason ? (
        <p className="settings-permission-note" role="status">
          {reason}
        </p>
      ) : null}
    </>
  );
}
