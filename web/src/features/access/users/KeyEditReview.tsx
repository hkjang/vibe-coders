import type { RefObject } from "react";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";

export interface KeyEditChange {
  label: string;
  before: string;
  after: string;
}

export function KeyEditReview({
  changes,
  signature,
  confirmation,
  ready,
  attempted,
  canWrite,
}: {
  changes: KeyEditChange[];
  signature: string;
  confirmation: RefObject<HTMLInputElement | null>;
  ready: boolean;
  attempted: boolean;
  canWrite: boolean;
}) {
  return (
    <>
      <section aria-label="변경 전후 비교" className="access-stack access-key-edit-review">
        <h3>변경 전후 비교</h3>
        {changes.length ? (
          <div className="data-table-scroll" tabIndex={0} role="region" aria-label="변경 비교 표 가로 스크롤">
            <table className="data-table">
              <caption className="sr-only">저장할 API 키 변경 내용</caption>
              <thead>
                <tr>
                  <th scope="col">항목</th>
                  <th scope="col">변경 전</th>
                  <th scope="col">변경 후</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((change) => (
                  <tr key={change.label}>
                    <th scope="row">{change.label}</th>
                    <td>{change.before || "미지정"}</td>
                    <td>{change.after || "미지정"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>변경된 항목이 없습니다.</p>
        )}
      </section>
      {!canWrite ? (
        <InlineNotice tone="warning">
          현재 변경 권한이 없습니다. 초안은 유지되며 취소할 수 있습니다.
        </InlineNotice>
      ) : null}
      {!ready && !attempted ? (
        <InlineNotice tone="warning">
          키를 조회 중이거나 정보가 바뀌었거나 서버가 검토 수정을 지원하지 않습니다. 창을 닫고 최신 목록에서
          다시 검토하세요. 구버전 서버에서는 기존 관리자 화면을 이용하세요.
        </InlineNotice>
      ) : null}
      {attempted ? (
        <InlineNotice tone="warning">
          변경을 요청해 이 창의 중복 전송을 막았습니다. 결과가 불확실하면 목록과 감사 이력에서 적용 여부를
          확인하세요.
        </InlineNotice>
      ) : null}
      <Checkbox
        key={JSON.stringify([signature, ready, canWrite, attempted])}
        ref={confirmation}
        label="변경 내용과 영향을 확인했습니다"
        defaultChecked={false}
        disabled={!ready || !canWrite || attempted || changes.length === 0}
        description="입력 내용이나 조회 상태가 바뀌면 다시 확인해야 합니다."
      />
    </>
  );
}
