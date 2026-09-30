import { useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ModelUsageTag } from "@/shared/api/schemas";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime } from "@/shared/utils/format";
import { safeModelLabel } from "./chat-console";
import { useModelTagAccess, type ModelTagAccess } from "./model-tag-access";
import { useModelTagData } from "./model-tag-data";
import { ModelTagEditor } from "./model-tag-editor";
import { ModelTagDelete } from "./model-tag-delete";

interface ModelTagPanelProps {
  canWrite: boolean;
  writeDeniedReason: string;
}
export function ModelTagPanel({ canWrite, writeDeniedReason }: ModelTagPanelProps): React.JSX.Element {
  const access = useModelTagAccess(canWrite, writeDeniedReason);
  // Runtime readonly/scope changes preserve drafts. A different route owner or
  // authentication epoch disposes them and every old operation's local lifetime.
  return <ModelTagConsole key={`${access.epoch}:${access.owner}:${access.known}`} access={access} />;
}
function ModelTagConsole({ access }: { access: ModelTagAccess }) {
  const data = useModelTagData(access);
  const [edit, setEdit] = useState<{ original?: ModelUsageTag }>();
  const [remove, setRemove] = useState<ModelUsageTag>();
  const trigger = useRef<HTMLElement | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const returnFocusRef = useMemo(
    () => ({
      get current() {
        if (trigger.current?.isConnected && !trigger.current.matches(":disabled")) return trigger.current;
        return createButton.current?.isConnected && !createButton.current.disabled
          ? createButton.current
          : panel.current;
      },
    }),
    [],
  );
  const reason = access.write.reason;
  const open = (trigger: HTMLElement, row?: ModelUsageTag) => {
    try {
      access.write.assertCurrent();
      access.assertRead();
    } catch {
      return;
    }
    // Opening a draft is not a write. Its save/delete controls remain locked
    // until the current list is confirmed, without moving the return-focus target.
    returnTrigger(trigger);
    setEdit({ original: row ? { ...row } : undefined });
  };
  const returnTrigger = (element: HTMLElement) => {
    trigger.current = element;
  };
  return (
    <div className="page-stack" ref={panel} tabIndex={-1}>
      <SectionCard
        title="모델 용도 태그"
        description="모델별 적합한 작업과 위험을 기록합니다. 같은 모델 ID에 저장하면 기존 태그 전체를 덮어씁니다."
        actions={
          <Button
            ref={createButton}
            size="small"
            variant="primary"
            disabled={!!reason}
            title={reason}
            onClick={(event) => open(event.currentTarget)}
          >
            <Plus aria-hidden="true" /> 태그 추가
          </Button>
        }
      >
        {access.write.reason ? (
          <InlineNotice tone="warning" title="태그 변경 잠김">
            {access.write.reason}
          </InlineNotice>
        ) : null}
        {!access.readAllowed ? (
          <InlineNotice tone="warning">
            현재 화면에서 태그를 조회하려면 admin:read 권한이 필요합니다.
          </InlineNotice>
        ) : (
          <>
            <Button
              size="small"
              variant="ghost"
              disabled={data.query.isFetching}
              onClick={() => void data.refresh().catch(() => undefined)}
            >
              태그 목록 새로고침
            </Button>
            {data.query.isError ? (
              <InlineNotice tone="warning" title="모델 용도 태그를 불러오지 못했습니다.">
                {safeAppErrorMessage(data.query.error, "목록을 다시 조회하세요.")}
                {isAppError(data.query.error) && data.query.error.requestId ? (
                  <p>요청 ID: {data.query.error.requestId}</p>
                ) : null}
              </InlineNotice>
            ) : null}
            {data.query.isFetching ? <p role="status">모델 용도 태그를 확인하고 있습니다.</p> : null}
            {!data.query.data ? null : data.query.data.tags.length === 0 ? (
              <EmptyState
                title="등록된 용도 태그가 없습니다."
                description="자주 쓰는 모델의 적합한 작업을 추가할 수 있습니다."
              />
            ) : (
              <div className="data-table-scroll" tabIndex={0} aria-label="모델 용도 태그 표 영역">
                <table className="data-table">
                  <caption className="sr-only">모델별 용도 태그</caption>
                  <thead>
                    <tr>
                      <th scope="col">모델</th>
                      <th scope="col">적합</th>
                      <th scope="col">부적합</th>
                      <th scope="col">위험 메모</th>
                      <th scope="col">수정 시각</th>
                      <th scope="col">작업</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.query.data.tags.map((row) => (
                      <tr key={row.model}>
                        <td>{safeModelLabel(row.model)}</td>
                        <td>{row.good_for || "-"}</td>
                        <td>{row.avoid_for || "-"}</td>
                        <td className="truncate">{row.risk_note || "-"}</td>
                        <td>{formatDateTime(row.updated_at)}</td>
                        <td>
                          <div className="toolbar-start">
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={!!reason}
                              title={reason}
                              onClick={(event) => open(event.currentTarget, row)}
                            >
                              수정
                            </Button>
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={!!reason}
                              title={reason}
                              onClick={(event) => {
                                try {
                                  access.write.assertCurrent();
                                  access.assertRead();
                                } catch {
                                  return;
                                }
                                returnTrigger(event.currentTarget);
                                setRemove({ ...row });
                              }}
                            >
                              <Trash2 aria-hidden="true" /> 삭제
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </SectionCard>
      {edit ? (
        <ModelTagEditor
          original={edit.original}
          access={access}
          data={data}
          onClose={() => setEdit(undefined)}
          returnFocusRef={returnFocusRef}
        />
      ) : null}
      {remove ? (
        <ModelTagDelete
          row={remove}
          access={access}
          data={data}
          onClose={() => setRemove(undefined)}
          returnFocusRef={returnFocusRef}
        />
      ) : null}
    </div>
  );
}
