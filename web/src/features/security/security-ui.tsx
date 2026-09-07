import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { LoadingState } from "@/shared/components/state/PageStates";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

interface QueryFailureNoticeProps {
  error: unknown;
  /** Keep the last good data on screen and warn instead of blanking the tab. */
  hasPreviousData: boolean;
  label: string;
  onRetry: () => void;
}

export function QueryFailureNotice({
  error,
  hasPreviousData,
  label,
  onRetry,
}: QueryFailureNoticeProps): React.JSX.Element {
  const requestId = isAppError(error) ? error.requestId : undefined;
  return (
    <InlineNotice
      tone={hasPreviousData ? "warning" : "danger"}
      title={`${label} ${hasPreviousData ? "갱신에 실패해 마지막 정상 데이터를 표시합니다." : "조회에 실패했습니다."}`}
      actions={
        <Button size="small" variant="secondary" onClick={onRetry} aria-label={`${label} 재시도`}>
          <RefreshCw aria-hidden="true" /> 재시도
        </Button>
      }
    >
      <p>{safeAppErrorMessage(error, `${label} 데이터를 확인할 수 없습니다.`)}</p>
      {requestId ? <p className="request-id">요청 ID: {requestId}</p> : null}
    </InlineNotice>
  );
}

/** Explains a missing gateway scope instead of hiding the tab's content. */
export function ScopeNotice({ scope, what }: { scope: string; what: string }): React.JSX.Element {
  return (
    <InlineNotice tone="info" title={`${what}를 볼 권한이 없습니다.`}>
      관리자에게 <code>{scope}</code> 권한을 요청하세요.
    </InlineNotice>
  );
}

interface QuerySectionProps {
  children: ReactNode;
  error: unknown;
  hasData: boolean;
  label: string;
  onRetry: () => void;
  pending: boolean;
}

/** Loading, partial-failure and content states shared by every security tab. */
export function QuerySection({
  children,
  error,
  hasData,
  label,
  onRetry,
  pending,
}: QuerySectionProps): React.JSX.Element {
  return (
    <>
      {error ? (
        <QueryFailureNotice error={error} hasPreviousData={hasData} label={label} onRetry={onRetry} />
      ) : null}
      {pending && !hasData ? <LoadingState label={`${label}를 불러오는 중입니다.`} /> : null}
      {hasData ? children : null}
    </>
  );
}
