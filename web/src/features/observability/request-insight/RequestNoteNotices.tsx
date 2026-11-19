import { RequestLegacyLink } from "./RequestLegacyLink";
import type { useRequestNoteQuery } from "./use-request-note-editor";
import { requestNoteContractMessage } from "./request-note-state";
import { isAppError } from "@/shared/api/error";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export function RequestNoteNotices({
  supported,
  requestId,
  current,
}: {
  supported: boolean;
  requestId: string;
  current: ReturnType<typeof useRequestNoteQuery>;
}): React.JSX.Element | null {
  if (!supported)
    return (
      <InlineNotice tone="warning" title="메모·태그 편집의 서버 버전을 확인하세요.">
        <p>{requestNoteContractMessage}</p>
        <RequestLegacyLink requestId={requestId} />
      </InlineNotice>
    );
  if (current.confirmed) return null;
  return (
    <InlineNotice tone="warning" title="현재 메모·태그를 확인하기 전에는 변경할 수 없습니다.">
      {current.query.isError
        ? safeAppErrorMessage(current.query.error, "메모·태그를 불러오지 못했습니다.")
        : "메모·태그를 조회 중이거나 다시 조회해야 합니다. 열린 초안은 유지됩니다."}
      {isAppError(current.query.error) && current.query.error.requestId ? (
        <span className="request-id"> 요청 ID: {current.query.error.requestId}</span>
      ) : null}
    </InlineNotice>
  );
}
