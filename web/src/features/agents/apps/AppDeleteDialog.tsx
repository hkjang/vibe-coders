import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { appsKey, useAppOperationAccess, useAppRead } from "./app-scope";
import { apiClient } from "@/shared/api/client";
import { workAppDetailSchema, type WorkAppDetail } from "@/shared/api/domains/agents.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import { ErrorState, LoadingState } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { containsPotentialSecret } from "@/shared/security/secrets";

interface Props {
  id: string;
  onClose: () => void;
  onDelete: (id: string) => Promise<unknown>;
  returnFocusRef: RefObject<HTMLElement | null>;
}

const changedMessage = "앱 정보가 변경되었습니다. 취소한 뒤 삭제창을 다시 열어 최신 내용을 확인하세요.";
const description = "최신 앱 정보와 삭제 대상을 확인하세요. 삭제한 앱 정의는 되돌릴 수 없습니다.";

export function AppDeleteDialog(props: Props) {
  const auth = useAuth();
  const safeId = props.id.trim() !== "" && !containsPotentialSecret(props.id, auth.credentialPrefixes);
  const review = useAppRead({
    queryKey: [...appsKey, props.id, "delete-review"],
    enabled: safeId,
    queryFn: async ({ signal }) => {
      const result = await apiClient.request(
        withPathParams(endpoints.domains.agents.apps.get, { id: props.id }),
        {
          signal,
          cache: "no-store",
          routeId: "agents.apps",
        },
      );
      const parsed = workAppDetailSchema.safeParse(result);
      if (!parsed.success || parsed.data.id !== props.id)
        throw new AppError("업무 앱 삭제 대상 응답이 올바르지 않습니다.", { kind: "contract" });
      return parsed.data;
    },
  });
  if (safeId && review.data)
    return (
      <ReadyReview
        {...props}
        app={review.data}
        readLatest={async () => {
          const result = await review.refetch({ throwOnError: true });
          if (!result.data) throw new AppError("삭제 대상을 조회하지 못했습니다.", { kind: "contract" });
          return result.data;
        }}
      />
    );
  return (
    <Dialog
      open
      title="업무 앱 삭제"
      description={description}
      returnFocusRef={props.returnFocusRef}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      footer={
        <Button variant="secondary" onClick={props.onClose}>
          취소
        </Button>
      }
    >
      {!safeId || review.isError ? (
        <ErrorState
          title="삭제 대상을 확인하지 못했습니다."
          message={
            !safeId
              ? "앱 식별자를 안전하게 표시할 수 없습니다."
              : safeAppErrorMessage(review.error, "앱이 삭제되었거나 조회할 수 없습니다.")
          }
          requestId={isAppError(review.error) ? review.error.requestId : undefined}
          onRetry={safeId ? () => void review.refetch() : undefined}
          showLegacy={false}
        />
      ) : (
        <LoadingState label="최신 삭제 대상을 확인하는 중입니다." />
      )}
    </Dialog>
  );
}

function ReadyReview({
  app,
  readLatest,
  ...props
}: Props & {
  app: WorkAppDetail;
  readLatest: () => Promise<WorkAppDetail>;
}) {
  // Keep what the operator actually reviewed, even if focus refetch updates the query.
  const [reviewed] = useState(app);
  const [changed, setChanged] = useState(false);
  const [dispatched, setDispatched] = useState(false);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const operations = useAppOperationAccess();
  const auth = useAuth();
  const title = containsPotentialSecret(reviewed.title, auth.credentialPrefixes)
    ? "민감한 제목은 표시하지 않습니다."
    : reviewed.title || "제목 없음";
  const status =
    reviewed.status === "active" ? "활성" : reviewed.status === "archived" ? "보관" : "기타 상태";
  return (
    <ConfirmDialog
      open
      title="업무 앱 삭제"
      description={description}
      confirmLabel="삭제"
      tone="danger"
      requireTarget={props.id}
      returnFocusRef={props.returnFocusRef}
      confirmDisabled={!operations.allowed || changed || dispatched}
      scrollBody
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      onConfirm={async () => {
        operations.assertCurrent();
        if (!mounted.current || changed || dispatched)
          throw new AppError("삭제 확인 상태가 변경되었습니다.", { kind: "aborted" });
        const latest = await readLatest();
        operations.assertCurrent();
        if (!mounted.current) throw new AppError("삭제 확인창이 닫혔습니다.", { kind: "aborted" });
        // Schema parsing fixes property order and includes every persisted definition field.
        // This detects changes observed by GET; it is not an atomic server-side precondition.
        if (JSON.stringify(latest) !== JSON.stringify(reviewed)) {
          setChanged(true);
          throw new AppError("삭제 대상 변경", { kind: "contract", code: "app_delete_changed" });
        }
        setDispatched(true);
        await props.onDelete(props.id);
      }}
      errorFormatter={(error, fallback) =>
        isAppError(error) && error.code === "app_delete_changed"
          ? changedMessage
          : safeAppErrorMessage(error, fallback)
      }
    >
      <dl className="app-delete-summary" aria-label="삭제 대상 요약">
        <div>
          <dt>앱 이름</dt>
          <dd>{title}</dd>
        </div>
        <div>
          <dt>앱 ID</dt>
          <dd>{props.id}</dd>
        </div>
        <div>
          <dt>상태</dt>
          <dd>{status}</dd>
        </div>
        <div>
          <dt>구성 요소</dt>
          <dd>{reviewed.components.length}개</dd>
        </div>
      </dl>
      <InlineNotice tone="warning" title="삭제 영향 확인">
        앱의 실행 진입점이 사라집니다. 구성 요소 수는 전체 참조 영향도가 아닙니다. 삭제 직전 앱 정의를 다시
        조회하지만, 이후 발생하는 동시 변경까지 차단하지는 않습니다.
      </InlineNotice>
      {!operations.allowed ? (
        <InlineNotice tone="warning" title="현재 변경할 수 없습니다.">
          {operations.reason}
        </InlineNotice>
      ) : null}
      {dispatched ? (
        <InlineNotice tone="warning" title="삭제 요청을 전송했습니다.">
          응답을 확인하지 못했다면 취소 후 목록과 감사 이력을 확인하세요. 이 확인창에서는 다시 전송하지
          않습니다.
        </InlineNotice>
      ) : null}
    </ConfirmDialog>
  );
}
