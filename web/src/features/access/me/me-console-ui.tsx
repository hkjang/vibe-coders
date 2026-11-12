import type { ReactNode } from "react";
import { isAppError } from "@/shared/api/error";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Button } from "@/shared/components/ui/Button";
import { LoadingState } from "@/shared/components/state/PageStates";
import { safeMeMessage } from "./me-console-model";
export function MeQueryNotice({
  query,
  label,
}: {
  label: string;
  query: { isError: boolean; error: unknown; refetch: () => unknown };
}) {
  if (!query.isError) return null;
  return (
    <InlineNotice tone="danger" title={label + " 조회 실패"}>
      {safeMeMessage(query.error)}
      {isAppError(query.error) && query.error.requestId ? (
        <span className="request-id"> 요청 ID: {query.error.requestId}</span>
      ) : null}
      <Button size="small" onClick={() => void query.refetch()}>
        다시 조회
      </Button>
    </InlineNotice>
  );
}
export function MeQueryContent({
  query,
  label,
  children,
}: {
  label: string;
  query: { isPending: boolean; isError: boolean; data: unknown; error: unknown; refetch: () => unknown };
  children: ReactNode;
}) {
  return (
    <>
      {query.isPending && !query.data ? <LoadingState label={label + " 불러오는 중입니다."} /> : null}
      <MeQueryNotice query={query} label={label} />
      {query.isError && query.data ? (
        <p className="access-note">마지막으로 정상 조회한 결과입니다. 현재 상태는 다시 조회해 확인하세요.</p>
      ) : null}
      {query.data ? children : null}
    </>
  );
}
export function MePartial({ failures }: { failures: readonly string[] | undefined }) {
  if (!failures?.length) return null;
  return (
    <InlineNotice tone="warning" title="일부 정보를 확인하지 못했습니다.">
      실패한 항목의 빈 목록과 0은 확정된 결과가 아닙니다. 다시 조회해 확인하세요.
    </InlineNotice>
  );
}
export function MeOperationNotice({ pending, uncertain }: { pending: boolean; uncertain: boolean }) {
  if (uncertain)
    return (
      <InlineNotice tone="warning">
        처리 결과가 불확실해 중복 전송을 막았습니다. 저장 상태를 확인한 뒤 페이지를 새로고침하세요.
      </InlineNotice>
    );
  return pending ? <p role="status">처리 중입니다. 같은 작업의 중복 전송을 막고 있습니다.</p> : null;
}
