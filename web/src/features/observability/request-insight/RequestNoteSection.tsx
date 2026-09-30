import { useRequestNoteContext } from "./request-note-context";
import { RequestNoteDialog } from "./RequestNoteDialog";
import { RequestNoteNotices } from "./RequestNoteNotices";
import { useRequestNoteQuery } from "./use-request-note-editor";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatDateTime } from "@/shared/utils/format";

export function RequestNoteSection({
  requestId,
  canWrite,
}: {
  requestId: string;
  canWrite: boolean;
}): React.JSX.Element {
  const editor = useRequestNoteContext();
  const current = useRequestNoteQuery(requestId, editor.epoch);
  const confirmed = editor.supported ? current.confirmed : undefined;
  const allowed = canWrite && editor.writable;
  return (
    <SectionCard
      headingLevel={3}
      title="운영 메모·태그"
      description="이 요청에 대해 팀이 공유하는 메모와 태그입니다. 프롬프트 원문은 적지 마세요."
    >
      <RequestNoteNotices supported={editor.supported} current={current} />
      {!allowed ? (
        <InlineNotice tone="warning" title="쓰기 권한이 없습니다.">
          {editor.writeDisabledReason ?? "요청 메모 작성에는 admin:write 권한이 필요합니다."}
        </InlineNotice>
      ) : null}
      {confirmed ? (
        <>
          <p className="request-note-value">메모: {confirmed.note || "내용 없음"}</p>
          <p className="request-note-value">태그: {confirmed.tags.join(", ") || "태그 없음"}</p>
          {confirmed.redacted_fields.length ? (
            <p>일부 내용이 마스킹되어 있습니다. 원문 조회 권한과 쓰기 권한은 서로 다릅니다.</p>
          ) : null}
          {confirmed.exists ? (
            <p className="obs-meta">
              마지막 수정 {formatDateTime(confirmed.updated_at)} · {confirmed.created_by || "—"}
            </p>
          ) : (
            <p>저장된 메모·태그가 없습니다.</p>
          )}
        </>
      ) : null}
      {editor.committed?.id === requestId && !confirmed ? (
        <InlineNotice
          tone="warning"
          title={
            editor.committed.kind === "edit"
              ? "메모·태그 저장은 완료됐습니다."
              : "메모·태그 삭제는 완료됐습니다."
          }
        >
          후속 조회가 완료되지 않았습니다. 같은 변경을 다시 전송하지 말고 현재 메모·태그를 다시 조회하세요.
        </InlineNotice>
      ) : null}
      <div className="obs-note-actions">
        <Button
          disabled={current.query.isFetching || editor.pending}
          onClick={() => void current.query.refetch()}
        >
          메모·태그 새로고침
        </Button>
        <Button
          variant="primary"
          disabled={!allowed || !confirmed || Boolean(editor.target)}
          onClick={(event) => {
            if (allowed) editor.open(requestId, "edit", event.currentTarget);
          }}
        >
          메모·태그 수정
        </Button>
        <Button
          variant="danger"
          disabled={!allowed || !confirmed?.exists || Boolean(editor.target)}
          onClick={(event) => {
            if (allowed) editor.open(requestId, "delete", event.currentTarget);
          }}
        >
          태그·메모 삭제
        </Button>
      </div>
      {editor.target?.requestId === requestId ? (
        <RequestNoteDialog
          key={`${editor.target.epoch}:${editor.target.instance}`}
          target={editor.target}
          editor={editor}
          current={current}
          canWrite={allowed}
        />
      ) : null}
    </SectionCard>
  );
}
