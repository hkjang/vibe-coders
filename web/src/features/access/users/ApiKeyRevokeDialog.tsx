import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useState, useSyncExternalStore, type RefObject } from "react";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";

export interface KeyRevokeSubmission {
  id: string;
  hard: boolean;
  reason: string;
  expected_revision: string;
}
interface Catalog {
  api_keys: ApiKeyPublic[];
  revoke_review_supported?: boolean;
}
interface Props {
  target: ApiKeyPublic;
  catalogKey: QueryKey;
  canWrite: boolean;
  isSuperAdmin: boolean;
  reason?: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onAttempt: (id: string) => void;
  onRejected: (id: string) => void;
  onSubmit: (input: KeyRevokeSubmission) => Promise<unknown>;
}

export function ApiKeyRevokeDialog({
  target,
  catalogKey,
  canWrite,
  isSuperAdmin,
  reason,
  returnFocusRef,
  onClose,
  onAttempt,
  onRejected,
  onSubmit,
}: Props): React.JSX.Element {
  const client = useQueryClient();
  const [baseline] = useState(target);
  const [hard, setHard] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [rejected, setRejected] = useState(false);
  const state = useSyncExternalStore(
    useCallback((notify) => client.getQueryCache().subscribe(notify), [client]),
    useCallback(() => client.getQueryState<Catalog>(catalogKey), [client, catalogKey]),
  );
  const reviewed = () => {
    const current = client.getQueryState<Catalog>(catalogKey);
    const row = current?.data?.api_keys.find((key) => key.id === baseline.id);
    return (
      current?.status === "success" &&
      current.fetchStatus === "idle" &&
      !current.isInvalidated &&
      current.data?.revoke_review_supported === true &&
      /^[a-f0-9]{64}$/.test(baseline.revision) &&
      row?.revision === baseline.revision &&
      row.status !== "revoked"
    );
  };
  const ready = state !== undefined && reviewed();
  return (
    <ConfirmDialog
      open
      title="API 키 폐기"
      tone="danger"
      confirmLabel="폐기"
      errorFormatter={(error, fallback) => {
        const code = isAppError(error) ? error.code : undefined;
        if (code === "key_revoke_conflict")
          return "검토 후 키 정보가 변경되어 폐기하지 않았습니다. 최신 목록에서 다시 검토하세요.";
        if (code === "invalid_key_revoke") return "대상 키와 변경 사유를 다시 확인하세요.";
        if (code === "key_revoke_authority_unavailable")
          return "검토 정보를 확인할 수 없어 폐기하지 않았습니다.";
        if (code === "key_revoke_failed")
          return "폐기 결과를 확인할 수 없습니다. 재전송하지 말고 목록과 감사 이력을 확인하세요.";
        return safeAppErrorMessage(error, fallback);
      }}
      description="이 키를 쓰는 클라이언트의 새 인증이 거부됩니다. 이미 처리 중인 요청의 취소나 외부 클라이언트 목록 확인을 의미하지 않습니다."
      requireTarget={baseline.id}
      requireReason
      returnFocusRef={returnFocusRef}
      confirmDisabled={!canWrite || !ready || attempted || (hard && !isSuperAdmin)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onConfirm={async (auditReason) => {
        if (!canWrite || !reviewed() || attempted || (hard && !isSuperAdmin))
          throw new AppError("최신 키 정보와 현재 권한을 다시 확인하세요.", { kind: "aborted" });
        if ([...auditReason].length > 1024)
          throw new AppError("변경 사유는 1,024자 이하로 입력하세요.", { kind: "contract" });
        setAttempted(true);
        onAttempt(baseline.id);
        try {
          await onSubmit({
            id: baseline.id,
            hard,
            reason: auditReason,
            expected_revision: baseline.revision,
          });
        } catch (error) {
          // Only these exact server responses certify no write. Network, timeout,
          // generic 5xx and mismatched code/status pairs remain locked.
          if (
            isAppError(error) &&
            error.kind === "http" &&
            ((error.status === 400 && error.code === "invalid_key_revoke") ||
              (error.status === 409 && error.code === "key_revoke_conflict") ||
              (error.status === 503 && error.code === "key_revoke_authority_unavailable"))
          ) {
            setRejected(true);
            onRejected(baseline.id);
          }
          throw error;
        }
        onClose();
      }}
    >
      <KeyValueList
        items={[
          { label: "키 이름", value: baseline.name || "이름 없는 키" },
          { label: "키 식별자", value: baseline.id, mono: true },
          { label: "소유자", value: baseline.owner || "미지정" },
          { label: "팀", value: baseline.team || "미지정" },
          { label: "권한", value: baseline.scopes.join(", ") || "선택된 권한 없음" },
        ]}
      />
      {isSuperAdmin ? (
        <Checkbox
          label="완전 삭제"
          checked={hard}
          disabled={attempted || !canWrite}
          description="키 등록 행만 삭제합니다. 기존 요청·감사 이력과 교체 이력은 남으며 키 등록은 복구할 수 없습니다."
          onChange={(event) => setHard(event.target.checked)}
        />
      ) : null}
      {!canWrite ? <InlineNotice tone="warning">{reason}</InlineNotice> : null}
      {!ready && !attempted ? (
        <InlineNotice tone="warning">
          조회 중이거나 키 정보가 바뀌었거나 서버가 검토 폐기를 지원하지 않습니다. 최신 서버와 목록을 확인한
          뒤 다시 검토하세요.
        </InlineNotice>
      ) : null}
      {rejected ? (
        <InlineNotice tone="info">
          서버가 키를 변경하지 않았음을 확인했습니다. 창을 닫고 최신 목록에서 다시 검토하세요.
        </InlineNotice>
      ) : attempted ? (
        <InlineNotice tone="warning">
          이 키에 폐기를 요청해 중복 전송을 막았습니다. 응답을 받지 못했다면 다시 요청하지 말고 목록과 감사
          이력에서 적용 여부를 확인하세요.
        </InlineNotice>
      ) : null}
    </ConfirmDialog>
  );
}
