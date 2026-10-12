import { UpdatedTime } from "@/features/health/health-ui";
import { overviewReadDenied } from "@/features/overview/overview-query-state";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export function OverviewQueryFeedback({
  label,
  error,
  fetching,
  updatedAt,
  retry,
}: {
  label: string;
  error: unknown;
  fetching: boolean;
  updatedAt: number;
  retry: () => void;
}): React.JSX.Element {
  const denied = overviewReadDenied(error);
  return (
    <>
      {error ? (
        <InlineNotice
          tone={denied ? "danger" : "warning"}
          title={`${label} 조회를 완료하지 못했습니다.`}
          actions={
            <Button
              size="small"
              variant="secondary"
              disabled={fetching}
              aria-label={`${label} 다시 시도`}
              onClick={retry}
            >
              다시 시도
            </Button>
          }
        >
          <p>{safeAppErrorMessage(error, `${label} 데이터를 확인할 수 없습니다.`)}</p>
          {!denied && updatedAt > 0 ? (
            <p>마지막 정상 데이터를 표시합니다. 현재 상태와 다를 수 있습니다.</p>
          ) : null}
          {isAppError(error) && error.requestId ? <p>요청 ID: {error.requestId}</p> : null}
        </InlineNotice>
      ) : null}
      {fetching && updatedAt > 0 && !denied ? (
        <p className="obs-meta" role="status">
          {label} 새 데이터를 확인하는 중입니다.
        </p>
      ) : null}
      {updatedAt > 0 && !denied ? (
        <UpdatedTime timestamp={updatedAt} label={error ? "마지막 정상 갱신" : undefined} />
      ) : null}
    </>
  );
}
