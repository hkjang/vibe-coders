import { useState, type RefObject } from "react";
import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import type { ModelUsageTag } from "@/shared/api/schemas";
import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useModelTagOperation, type ModelTagAccess } from "./model-tag-access";
import type { ModelTagData } from "./model-tag-data";
import {
  assertTagBaseline,
  assertTagDeleteIdentity,
  displayTagModel,
  sameTag,
  tagDeleteIdentityReason,
  tagListReason,
} from "./model-tag-state";
import "./model-tag.css";

export function ModelTagDelete({
  row,
  access,
  data,
  onClose,
  returnFocusRef,
}: {
  row: ModelUsageTag;
  access: ModelTagAccess;
  data: ModelTagData;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [baseline, setBaseline] = useState(() => ({ ...row }));
  const operation = useModelTagOperation(access);
  const current = data.query.data?.tags.find((candidate) => candidate.model === row.model);
  const reason =
    access.write.reason ??
    tagDeleteIdentityReason(row.model) ??
    (!data.confirmed ? tagListReason : undefined) ??
    (!sameTag(current, baseline)
      ? "삭제 대상이 변경되거나 없습니다. 목록과 최신 삭제 대상을 다시 확인하세요."
      : undefined);
  return (
    <ConfirmDialog
      open
      title="모델 용도 태그 삭제"
      description="선택한 원본 모델 ID의 용도 태그만 삭제합니다. 모델 자체를 삭제하는 작업은 아닙니다."
      tone="danger"
      confirmLabel="삭제"
      confirmDisabled={operation.pending || !!reason}
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onConfirm={async () => {
        await operation.run(
          async (assert, signal) => {
            assertTagDeleteIdentity(row.model);
            assertTagBaseline(data.assertConfirmed(), row.model, baseline);
            const endpoint = withPathParams(endpoints.domains.gateway.models.tags.remove, { id: row.model });
            assert();
            return apiClient.request(endpoint, { signal, routeId: "gateway.chat" });
          },
          () => {
            toast.success("모델 용도 태그를 삭제했습니다.");
            data.afterCommit();
          },
        );
      }}
    >
      <dl className="model-tag-delete-target">
        <dt>삭제할 원본 모델 ID</dt>
        <dd>{displayTagModel(row.model)}</dd>
      </dl>
      <p>공백·FEFF는 문자 코드로, 역슬래시는 두 번 표시합니다.</p>
      {reason ? (
        <InlineNotice tone="warning" title="태그 삭제 잠김">
          {reason} 선택한 원본 ID는 유지됩니다.
        </InlineNotice>
      ) : null}
      {data.query.isError ? (
        <InlineNotice tone="warning" title="태그 목록 조회 실패">
          {safeAppErrorMessage(data.query.error, "목록을 다시 조회하세요.")}
          {isAppError(data.query.error) && data.query.error.requestId ? (
            <p>요청 ID: {data.query.error.requestId}</p>
          ) : null}
        </InlineNotice>
      ) : null}
      <Button
        disabled={operation.pending || data.query.isFetching || !access.readAllowed}
        onClick={() => void data.refresh().catch(() => undefined)}
      >
        목록 다시 조회
      </Button>
      <Button
        disabled={operation.pending || !access.write.allowed || !data.confirmed || !current}
        onClick={() => {
          try {
            access.write.assertCurrent();
            const latest = data.assertConfirmed().find((candidate) => candidate.model === row.model);
            if (latest) setBaseline({ ...latest });
          } catch {
            /* keep the target locked */
          }
        }}
      >
        최신 삭제 대상 확인
      </Button>
      <p>
        확인한 목록 기준으로 정확한 원본 ID를 전송합니다. 서버의 동시 변경 차단이나 복구를 보장하지 않습니다.
      </p>
    </ConfirmDialog>
  );
}
