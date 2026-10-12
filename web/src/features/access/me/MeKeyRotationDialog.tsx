import { useQueryClient, type QueryKey, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

import { confirmedMeScopeCatalog, type MeKeyCatalog } from "./me-key-scopes";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { AppError, isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { Select } from "@/shared/components/ui/Select";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { formatDateTime } from "@/shared/utils/format";
import { canRotateMeKey } from "./me-key-rotation";
import { meKeyErrorMessage } from "./me-key-errors";

interface Props {
  target: ApiKeyPublic;
  catalogKey: QueryKey;
  catalogQuery: UseQueryResult<MeKeyCatalog>;
  returnFocusRef: RefObject<HTMLElement | null>;
  ownsResult: () => boolean;
  onAttempt: (id: string) => void;
  onSuccess: (secret: string) => void;
  onAccessDenied: () => void;
  onClose: () => void;
}

export function MeKeyRotationDialog({
  target,
  catalogKey,
  catalogQuery,
  returnFocusRef,
  ownsResult,
  onAttempt,
  onSuccess,
  onAccessDenied,
  onClose,
}: Props): React.JSX.Element {
  const client = useQueryClient();
  const [baseline] = useState(target);
  const [grace, setGrace] = useState("0");
  const [attempted, setAttempted] = useState(false);
  const sending = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const access = useFeatureMutationAccess(["me.home"], true);
  const state = useSyncExternalStore(
    useCallback((notify) => client.getQueryCache().subscribe(notify), [client]),
    useCallback(() => client.getQueryState<MeKeyCatalog>(catalogKey), [client, catalogKey]),
  );
  const reviewed = (): boolean => {
    const current = client.getQueryState<MeKeyCatalog>(catalogKey);
    const grantable = confirmedMeScopeCatalog(current);
    const row = current?.data?.api_keys.find((key) => key.id === baseline.id);
    return (
      current?.status === "success" &&
      current.fetchStatus === "idle" &&
      !current.isInvalidated &&
      row !== undefined &&
      row.revision === baseline.revision &&
      canRotateMeKey(row) &&
      grantable !== undefined &&
      row.scopes.every((scope) => grantable.includes(scope))
    );
  };
  const ready = state !== undefined && reviewed();
  return (
    <ConfirmDialog
      open
      title="키 회전"
      errorFormatter={meKeyErrorMessage}
      description="원래 권한·접근 제한·새 키의 만료일을 유지하며 비밀값을 교체합니다. 이전 키는 선택한 유예 기간까지만 사용할 수 있습니다."
      returnFocusRef={returnFocusRef}
      requireTarget={baseline.id}
      requireReason
      confirmLabel="회전"
      tone="danger"
      confirmDisabled={!access.allowed || !ready || attempted}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onConfirm={async (reason) => {
        access.assertCurrent();
        if (!mounted.current || !ownsResult() || sending.current || !reviewed()) {
          throw new AppError("최신 키 정보를 확인한 뒤 확인창을 다시 여세요.", { kind: "aborted" });
        }
        if ([...reason].length > 1024)
          throw new AppError("변경 사유는 1,024자 이하로 입력하세요.", { kind: "contract" });
        sending.current = true;
        setAttempted(true);
        onAttempt(baseline.id);
        const result = await apiClient
          .request(withPathParams(endpoints.domains.access.me.rotateKey, { id: baseline.id }), {
            body: { expected_revision: baseline.revision, reason, grace_seconds: Number(grace) },
            routeId: "me.home",
            retryUnauthorized: false,
          })
          .catch((error: unknown) => {
            if (
              mounted.current &&
              ownsResult() &&
              isAppError(error) &&
              (error.status === 401 ||
                error.status === 403 ||
                error.kind === "auth" ||
                error.kind === "permission")
            )
              onAccessDenied();
            throw error;
          });
        access.assertCurrent();
        if (!mounted.current || !ownsResult())
          throw new AppError("현재 화면의 인증을 다시 확인하세요.", { kind: "aborted" });
        if (
          result.rotated_from !== baseline.id ||
          !result.secret ||
          !result.api_key?.id ||
          !result.grace_ends_at
        ) {
          throw new AppError("회전 결과를 확인할 수 없습니다. 키 목록에서 적용 여부를 확인하세요.", {
            kind: "contract",
          });
        }
        onSuccess(result.secret);
        void client.invalidateQueries({ queryKey: catalogKey });
      }}
    >
      <KeyValueList
        items={[
          { label: "키 이름", value: baseline.name || "이름 없는 키" },
          { label: "키 식별자", value: baseline.id, mono: true },
          {
            label: "새 키 만료",
            value: baseline.expires_at ? formatDateTime(baseline.expires_at) : "무기한",
          },
          { label: "권한", value: baseline.scopes.join(", ") || "선택된 권한 없음" },
        ]}
      />
      <FormField
        label="이전 키 유예 기간"
        description="원래 만료일이 더 빠르면 그 시각까지만 허용됩니다. 새 키를 도구에 적용한 후 이전 키를 직접 폐기할 수도 있습니다."
      >
        {(control) => (
          <Select
            {...control}
            value={grace}
            disabled={attempted || !access.allowed}
            onChange={(event) => setGrace(event.target.value)}
          >
            <option value="0">즉시 폐기</option>
            <option value="300">5분</option>
            <option value="3600">1시간</option>
            <option value="86400">24시간</option>
          </Select>
        )}
      </FormField>
      <InlineNotice tone="warning">
        회전 전후 키는 일간·월간 할당량과 사용량을 함께 계산합니다. 회전해도 사용 한도가 초기화되지 않으며,
        요청 이력은 각 키에 따로 남습니다.
      </InlineNotice>
      <InlineNotice tone="warning">
        새 비밀값은 한 번만 표시됩니다. 응답을 받지 못했다면 다시 회전하지 말고 목록의 대체 키를 확인하세요.
        비밀값을 잃은 새 키는 폐기한 뒤 다시 발급해야 합니다.
      </InlineNotice>
      {attempted ? (
        <InlineNotice tone="warning">
          이 키에 회전을 요청했습니다. 중복 요청을 막았습니다. 확인창을 닫고 목록을 새로고침해 결과를
          확인하세요.
        </InlineNotice>
      ) : null}
      {!ready && !attempted ? (
        <InlineNotice tone="warning">
          조회 중이거나 키 정보·권한이 변경되었습니다. 확인창을 닫고 최신 목록에서 다시 검토하세요.
        </InlineNotice>
      ) : null}
      {catalogQuery.isError ? (
        <InlineNotice tone="danger">키 조회에 실패해 회전을 중단했습니다.</InlineNotice>
      ) : null}
      {access.reason ? <InlineNotice tone="warning">{access.reason}</InlineNotice> : null}
    </ConfirmDialog>
  );
}
