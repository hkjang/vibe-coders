import { useObservedMutation as useMutation } from "@/shared/hooks/use-observed-mutation";
import { useQueryClient } from "@tanstack/react-query";
import { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "@/shared/notifications/toast";
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
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime } from "@/shared/utils/format";
import {
  emergencyReviewError,
  useRedTeamEmergencyState,
  type RedTeamEmergencySnapshot,
} from "./use-redteam-emergency-state";

const scope =
  "응답한 서버 프로세스의 새 캠페인·예약 실행과 다음 테스트 진입을 제어합니다. 이미 전송한 모델 호출과 다른 서버는 중단하지 않습니다. 재시작 시 중지 상태는 초기화되며, 해제해도 중단된 실행을 자동 재개하지 않습니다.";
const uncertain =
  "처리 결과를 확정할 수 없습니다. 같은 변경을 다시 보내지 않습니다. 현재 상태를 조회하고 취소한 뒤 새로 검토하세요.";
const reasonLengthMessage = "변경 사유는 1,000자 이내로 입력하세요.";
const target = { stop: "레드팀 처리 중지", resume: "레드팀 처리 재개" };
interface Review {
  id: number;
  action: "stop" | "resume";
  snapshot: RedTeamEmergencySnapshot;
}

export function RedTeamEmergencyPanel({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const readable =
    ["authenticated", "legacy", "open"].includes(auth.mode) &&
    auth.user?.scopes.includes("admin:read") === true &&
    context?.featureId === "security.redteam" &&
    context.permitted;
  const owner = JSON.stringify([
    epoch,
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.team_id,
    auth.user?.scopes,
    readable,
  ]);
  if (!readable)
    return (
      <InlineNotice tone="warning" title="레드팀 긴급 제어를 조회할 수 없습니다.">
        현재 화면과 조회 권한을 확인하세요.
      </InlineNotice>
    );
  return <EmergencyPanel key={owner} owner={owner} canWrite={canWrite} />;
}

function EmergencyPanel({ owner, canWrite }: { owner: string; canWrite: boolean }): React.JSX.Element {
  const client = useQueryClient();
  const access = useFeatureMutationAccess(
    ["security.redteam"],
    canWrite,
    "변경에는 admin:write 권한이 필요합니다.",
  );
  const query = useRedTeamEmergencyState(owner);
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
    observation: (value) => (value.review.action === "stop" ? "deactivate" : "activate"),
    retry: false,
    gcTime: 0,
    mutationFn: async (input: { review: Review; reason: string }) => {
      access.assertCurrent();
      selected(input.review);
      query.assertState(input.review.snapshot);
      const reviewToken = input.review.snapshot.data.review_token;
      if (!reviewToken) throw emergencyReviewError();
      if (!active.current || active.current.sent) throw emergencyReviewError();
      active.current.sent = true;
      setSent(true);
      const enabled = input.review.action === "stop";
      try {
        const result = await apiClient.request(endpoints.domains.redteam.killSwitch.set, {
          body: {
            enabled,
            reason: input.reason,
            expected_review_token: reviewToken,
          },
          routeId: "security.redteam",
          retryUnauthorized: false,
        });
        selected(input.review);
        access.assertCurrent();
        if (
          result.enabled !== enabled ||
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
          ? "해당 서버의 레드팀 처리를 중지했습니다."
          : "해당 서버의 레드팀 중지를 해제했습니다.",
      );
    },
  });
  const action = state.data?.enabled ? "resume" : "stop";
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
        className="rt-emergency"
        title="레드팀 긴급 제어"
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
          레드팀 상태 다시 확인
        </Button>
        <p role="status">
          <Badge tone={query.ready ? (state.data?.enabled ? "danger" : "info") : "warning"}>
            {state.isPending
              ? "상태 확인 중"
              : state.data
                ? `${query.ready ? "" : "마지막 확인: "}${state.data.enabled ? "처리 중지" : "긴급 중지 해제"}`
                : "현재 상태 미확인"}
          </Badge>
        </p>
        {state.data?.instance_ref ? (
          <p>
            응답 서버: <code>{state.data.instance_ref}</code> · 확인 시각:{" "}
            {formatDateTime(state.data.observed_at)}
          </p>
        ) : null}
        {state.isError ? (
          <InlineNotice tone="warning" title="현재 레드팀 상태를 확인하지 못했습니다.">
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
        title={review?.action === "resume" ? "레드팀 처리 재개" : "레드팀 처리 중지"}
        description={scope}
        confirmLabel={review?.action === "resume" ? "재개" : "중지"}
        tone="danger"
        requireReason
        errorFormatter={(error, fallback) =>
          isAppError(error) && error.code === "redteam_reason_length"
            ? reasonLengthMessage
            : safeAppErrorMessage(error, fallback)
        }
        requireTarget={target[review?.action ?? "stop"]}
        confirmDisabled={!access.allowed || !query.ready || !matches || sent}
        onConfirm={async (reason, phrase) => {
          access.assertCurrent();
          if (!review || !reason.trim() || phrase !== target[review.action]) throw emergencyReviewError();
          if ([...reason.trim()].length > 1000)
            throw new AppError(reasonLengthMessage, { kind: "contract", code: "redteam_reason_length" });
          selected(review);
          query.assertState(review.snapshot);
          await mutation.mutateAsync({ review, reason: reason.trim() });
        }}
      >
        <p>변경 사유는 1,000자 이내로 입력하세요. 사유와 사용자·시각·전후 상태가 감사 이력에 기록됩니다.</p>
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
