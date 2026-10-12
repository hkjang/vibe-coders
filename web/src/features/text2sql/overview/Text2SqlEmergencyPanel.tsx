import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { Button } from "@/shared/components/ui/Button";
import { Badge } from "@/shared/components/ui/Badge";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatDateTime } from "@/shared/utils/format";
import {
  emergencyReviewError,
  useText2SQLEmergencyState,
  type Text2SQLEmergencySnapshot,
} from "./use-text2sql-emergency-state";

const scope =
  "응답한 서버 프로세스의 새 Text2SQL 처리만 제어합니다. 다른 서버와 이미 진행 중인 SQL은 중단하지 않으며, 서버 재시작 시 중지 상태는 초기화됩니다.";
const uncertain =
  "처리 결과를 확정할 수 없습니다. 같은 변경을 다시 보내지 않습니다. 현재 상태를 조회하고 취소한 뒤 새로 검토하세요.";
const target = { stop: "Text2SQL 처리 중지", resume: "Text2SQL 처리 재개" };
interface Review {
  id: number;
  action: "stop" | "resume";
  snapshot: Text2SQLEmergencySnapshot;
}

export function Text2SqlEmergencyPanel({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const readable =
    ["authenticated", "legacy", "open"].includes(auth.mode) &&
    auth.user?.scopes.includes("admin:read") === true &&
    context?.featureId === "text2sql.overview" &&
    context.permitted;
  const owner = JSON.stringify([
    epoch,
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.team_id,
    readable,
  ]);
  if (!readable)
    return (
      <InlineNotice tone="warning" title="Text2SQL 긴급 제어를 조회할 수 없습니다.">
        현재 화면과 조회 권한을 확인하세요.
      </InlineNotice>
    );
  return <EmergencyPanel key={owner} owner={owner} canWrite={canWrite} />;
}

function EmergencyPanel({ owner, canWrite }: { owner: string; canWrite: boolean }): React.JSX.Element {
  const client = useQueryClient();
  const access = useFeatureMutationAccess(
    ["text2sql.overview"],
    canWrite,
    "변경에는 admin:write 권한이 필요합니다.",
  );
  const query = useText2SQLEmergencyState(owner);
  const state = query.result;
  const [review, setReview] = useState<Review>();
  const [sent, setSent] = useState(false);
  const active = useRef<{ review: Review; sent: boolean } | undefined>(undefined);
  const sequence = useRef(0);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(
    () => () => {
      active.current = undefined;
    },
    [],
  );
  const selected = (candidate: Review) => {
    if (active.current?.review !== candidate) throw emergencyReviewError();
  };
  const mutation = useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: async (input: { review: Review; reason: string }) => {
      access.assertCurrent();
      selected(input.review);
      query.assertState(input.review.snapshot);
      if (!active.current || active.current.sent) throw emergencyReviewError();
      active.current.sent = true;
      setSent(true);
      const disabled = input.review.action === "stop";
      try {
        const result = await apiClient.request(endpoints.domains.text2sql.killSwitch.set, {
          body: {
            disabled,
            reason: input.reason,
            expected_review_token: input.review.snapshot.data.review_token,
          },
          routeId: "text2sql.overview",
          retryUnauthorized: false,
        });
        selected(input.review);
        if (
          result.disabled !== disabled ||
          result.reason !== input.reason ||
          result.scope !== "responding_process" ||
          result.instance_ref !== input.review.snapshot.data.instance_ref ||
          !result.review_token ||
          result.review_token === input.review.snapshot.data.review_token
        )
          throw new AppError(uncertain, { kind: "contract" });
        return result;
      } catch (cause) {
        selected(input.review);
        throw new AppError(uncertain, {
          kind: "contract",
          requestId: isAppError(cause) ? cause.requestId : undefined,
        });
      }
    },
    onSuccess: async (_result, input) => {
      if (active.current?.review !== input.review) return;
      await client.invalidateQueries({ queryKey: query.key, exact: true });
      if (active.current?.review !== input.review) return;
      toast.success(
        input.review.action === "stop"
          ? "해당 서버의 Text2SQL 처리를 중지했습니다."
          : "해당 서버의 Text2SQL 중지를 해제했습니다.",
      );
    },
  });
  const action = state.data?.disabled ? "resume" : "stop";
  const matches = Boolean(review && query.matches(review.snapshot));
  const openReview = (button: HTMLButtonElement) => {
    try {
      access.assertCurrent();
      const snapshot = query.capture();
      const next: Review = { id: ++sequence.current, action, snapshot };
      active.current = { review: next, sent: false };
      trigger.current = button;
      setSent(false);
      setReview(next);
    } catch {
      return;
    }
  };
  return (
    <>
      <SectionCard
        title="Text2SQL 긴급 제어"
        description={scope}
        actions={
          <Button
            variant={action === "stop" ? "danger" : "primary"}
            disabled={!access.allowed || !query.ready || !query.supported}
            title={access.reason}
            onClick={(event) => openReview(event.currentTarget)}
          >
            {target[action]} 검토
          </Button>
        }
      >
        <Button variant="secondary" disabled={state.isFetching} onClick={() => void state.refetch()}>
          Text2SQL 상태 다시 확인
        </Button>
        <p role="status">
          <Badge tone={query.ready ? (state.data?.disabled ? "danger" : "info") : "warning"}>
            {state.isPending
              ? "상태 확인 중"
              : state.data
                ? `${query.ready ? "" : "마지막 확인: "}${state.data.disabled ? "처리 중지" : "긴급 중지 해제"}`
                : "현재 상태 미확인"}
          </Badge>
        </p>
        {state.data?.config_enabled === false ? (
          <p>서버 설정에서 Text2SQL 기능이 꺼져 있습니다. 중지 해제만으로 기능이 활성화되지는 않습니다.</p>
        ) : null}
        {state.data?.instance_ref ? (
          <p>
            응답 서버: <code>{state.data.instance_ref}</code> · 확인 시각:{" "}
            {formatDateTime(state.data.observed_at)}
          </p>
        ) : null}
        {state.isError ? (
          <InlineNotice tone="warning" title="현재 Text2SQL 상태를 확인하지 못했습니다.">
            변경은 잠겨 있습니다. 상태를 다시 조회하세요.
            {isAppError(state.error) && state.error.requestId ? ` 요청 ID: ${state.error.requestId}` : ""}
          </InlineNotice>
        ) : null}
        {query.ready && !query.supported ? (
          <InlineNotice tone="warning" title="서버의 안전한 변경 검토 지원이 필요합니다.">
            기존 서버의 상태 조회만 제공합니다. 서버를 업그레이드한 뒤 변경을 검토하세요.
          </InlineNotice>
        ) : null}
        {!access.allowed ? <p>{access.reason}</p> : null}
      </SectionCard>
      <ConfirmDialog
        key={review?.id ?? "closed"}
        open={review !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            active.current = undefined;
            setReview(undefined);
          }
        }}
        returnFocusRef={trigger}
        title={review?.action === "resume" ? "Text2SQL 처리 재개" : "Text2SQL 처리 중지"}
        description={scope}
        confirmLabel={review?.action === "resume" ? "재개" : "중지"}
        tone="danger"
        requireReason
        requireTarget={target[review?.action ?? "stop"]}
        confirmDisabled={!access.allowed || !query.ready || !matches || sent}
        onConfirm={async (reason, phrase) => {
          access.assertCurrent();
          if (!review || !reason.trim() || phrase !== target[review.action]) throw emergencyReviewError();
          selected(review);
          query.assertState(review.snapshot);
          await mutation.mutateAsync({ review, reason: reason.trim() });
        }}
      >
        <p>
          검토 대상 서버: <code>{review?.snapshot.data.instance_ref}</code>
        </p>
        {sent && mutation.isError ? (
          <InlineNotice tone="warning" title="처리 결과 확인이 필요합니다.">
            {uncertain}
            <Button variant="secondary" disabled={state.isFetching} onClick={() => void state.refetch()}>
              현재 상태만 다시 조회
            </Button>
          </InlineNotice>
        ) : null}
        {!matches ? (
          <InlineNotice tone="warning" title="변경 기준을 다시 확인하세요.">
            상태가 갱신되었거나 불명확합니다. 취소 후 다시 검토하세요.
          </InlineNotice>
        ) : null}
        {!access.allowed ? <p>{access.reason}</p> : null}
      </ConfirmDialog>
    </>
  );
}
