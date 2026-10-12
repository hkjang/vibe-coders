import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OctagonAlert, Play } from "lucide-react";
import { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useAuth } from "@/app/auth/AuthProvider";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

import {
  GovernanceTable,
  PanelFailure,
  type GovernanceColumn,
} from "@/features/governance/policies/governance-parts";
import { apiClient } from "@/shared/api/client";
import { AppError, isAppError } from "@/shared/api/error";
import { useKillSwitchState, killSwitchReviewError, type KillSwitchSnapshot } from "./use-kill-switch-state";
import { KillSwitchTraffic } from "./KillSwitchTraffic";
import { killSwitchMessages } from "./kill-switch-messages";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { formatDateTime, formatNumber, formatRelative } from "@/shared/utils/format";

const routeId = "governance.policies";
const targetText = { stop: "게이트웨이 전체 정지", resume: "게이트웨이 운영 재개" };
interface Review {
  id: number;
  action: "stop" | "resume";
  snapshot: KillSwitchSnapshot;
}

export function KillSwitchSection({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const readable =
    ["authenticated", "legacy", "open"].includes(auth.mode) &&
    auth.user?.scopes.includes("admin:read") === true &&
    context?.featureId === routeId &&
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
      <InlineNotice tone="warning" title="긴급 정지 상태를 조회할 수 없습니다.">
        현재 화면과 admin:read 권한을 확인하세요.
      </InlineNotice>
    );
  return <KillSwitchPanel key={owner} owner={owner} canWrite={canWrite} />;
}

function KillSwitchPanel({ canWrite, owner }: { canWrite: boolean; owner: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const access = useFeatureMutationAccess(
    [routeId],
    canWrite,
    "긴급 정지 변경에는 admin:write 권한이 필요합니다.",
  );
  const [review, setReview] = useState<Review>();
  const confirming = review?.action;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const sequence = useRef(0);
  const active = useRef<{ review: Review; sent: boolean } | undefined>(undefined);
  const [sent, setSent] = useState(false);
  const query = useKillSwitchState(owner);
  const killSwitch = query.result;
  const stateReady = query.ready;
  const baselineMatches = review !== undefined && query.matches(review.snapshot);
  useLayoutEffect(
    () => () => {
      active.current = undefined;
    },
    [],
  );
  const openReview = (action: Review["action"], trigger: HTMLButtonElement) => {
    access.assertCurrent();
    const snapshot = query.capture();
    if (snapshot.data.disabled !== (action === "resume")) throw killSwitchReviewError();
    const next = { id: ++sequence.current, action, snapshot };
    active.current = { review: next, sent: false };
    triggerRef.current = trigger;
    setSent(false);
    setReview(next);
  };
  const assertSelected = (candidate: Review) => {
    if (active.current?.review !== candidate) throw killSwitchReviewError();
  };
  const incidents = useQuery({
    queryKey: query.incidentKey,
    gcTime: 0,
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.incidents, {
        query: { window: "7d" },
        signal,
        routeId,
      }),
  });

  const setKillSwitch = useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: async (variables: { review: Review; disabled: boolean; reason: string }) => {
      access.assertCurrent();
      assertSelected(variables.review);
      query.assertState(variables.review.snapshot);
      if (!active.current || active.current.sent) throw killSwitchReviewError();
      active.current.sent = true;
      setSent(true);
      try {
        const result = await apiClient.request(endpoints.domains.governance.killSwitch.set, {
          body: { disabled: variables.disabled, reason: variables.reason },
          routeId,
          retryUnauthorized: false,
        });
        assertSelected(variables.review);
        if (result.disabled !== variables.disabled || result.reason !== variables.reason)
          throw new AppError("응답이 검토한 변경과 다릅니다.", { kind: "contract" });
        return result;
      } catch (cause) {
        assertSelected(variables.review);
        throw new AppError(killSwitchMessages.uncertain, {
          kind: "contract",
          requestId: isAppError(cause) ? cause.requestId : undefined,
        });
      }
    },
    onSuccess: async (_result, variables) => {
      if (active.current?.review !== variables.review) return;
      await queryClient.invalidateQueries({ queryKey: query.key, exact: true });
      if (active.current?.review !== variables.review) return;
      toast.success(
        variables.disabled ? "게이트웨이를 긴급 정지했습니다." : "게이트웨이 운영을 재개했습니다.",
      );
    },
    onError: (error, variables) => {
      if (active.current?.review !== variables.review) return;
      toast.error(safeAppErrorMessage(error, killSwitchMessages.uncertainTitle), {
        description: isAppError(error) && error.requestId ? `요청 ID: ${error.requestId}` : undefined,
      });
    },
  });

  const disabled = killSwitch.data?.disabled === true;
  const incidentRows = incidents.data?.incidents ?? [];

  const incidentColumns: ReadonlyArray<GovernanceColumn<(typeof incidentRows)[number]>> = [
    { id: "provider", header: "공급자", cell: (row) => row.provider || "—" },
    { id: "started", header: "시작", cell: (row) => formatDateTime(row.started_at) },
    { id: "ended", header: "종료", cell: (row) => formatDateTime(row.ended_at) },
    {
      id: "failovers",
      header: "폴백",
      cell: (row) => <span className="cell-number">{formatNumber(row.failovers)}</span>,
    },
    {
      id: "errors",
      header: "5xx",
      cell: (row) => <span className="cell-number">{formatNumber(row.errors_5xx)}</span>,
    },
    {
      id: "users",
      header: "영향 사용자",
      cell: (row) => <span className="cell-number">{formatNumber(row.affected_users)}</span>,
    },
    {
      id: "ongoing",
      header: "상태",
      cell: (row) => (row.ongoing ? <Badge tone="danger">진행 중</Badge> : <Badge tone="muted">종료</Badge>),
    },
  ];

  return (
    <>
      <SectionCard
        title="게이트웨이 긴급 정지"
        description={killSwitchMessages.stop}
        actions={
          disabled ? (
            <Button
              variant="primary"
              disabled={!access.allowed || !stateReady}
              title={access.reason}
              onClick={(event) => {
                try {
                  openReview("resume", event.currentTarget);
                } catch {
                  return;
                }
              }}
            >
              <Play aria-hidden="true" /> 정상 운영 재개
            </Button>
          ) : (
            <Button
              variant="danger"
              disabled={!access.allowed || !stateReady}
              title={access.reason}
              onClick={(event) => {
                try {
                  openReview("stop", event.currentTarget);
                } catch {
                  return;
                }
              }}
            >
              <OctagonAlert aria-hidden="true" /> 새 요청 긴급 차단
            </Button>
          )
        }
      >
        <InlineNotice tone="warning" title="적용 범위를 확인하세요.">
          {killSwitchMessages.scope}
        </InlineNotice>
        <Button
          variant="secondary"
          disabled={killSwitch.isFetching}
          onClick={() => void killSwitch.refetch()}
        >
          긴급 정지 상태 다시 확인
        </Button>
        {killSwitch.isError ? (
          <PanelFailure
            error={killSwitch.error}
            hasData={Boolean(killSwitch.data)}
            label="긴급 정지 상태"
            onRetry={() => void killSwitch.refetch()}
          />
        ) : null}
        {killSwitch.isPending ? (
          <p role="status">긴급 정지 상태를 확인하는 중입니다.</p>
        ) : killSwitch.data ? (
          <>
            <KillSwitchTraffic traffic={killSwitch.data.traffic} stale={!stateReady} />
            {disabled && stateReady ? (
              <InlineNotice tone="danger" title="게이트웨이가 정지 상태입니다.">
                새 공통 프록시 요청을 차단 중입니다. 원인 해결 후 재개하세요.
              </InlineNotice>
            ) : null}
            <KeyValueList
              items={[
                {
                  label: "현재 상태",
                  value: (
                    <Badge tone={stateReady ? (disabled ? "danger" : "success") : "warning"}>
                      {stateReady ? "" : "마지막 확인: "}
                      {disabled ? "정지 중" : "정상 운영"}
                    </Badge>
                  ),
                },
                { label: "사유", value: killSwitch.data?.reason || "—" },
                {
                  label: "변경 시각",
                  value: killSwitch.data?.updated_at
                    ? `${formatRelative(killSwitch.data.updated_at)} (${formatDateTime(killSwitch.data.updated_at)})`
                    : "—",
                },
                { label: "변경자", value: killSwitch.data?.updated_by || "—" },
              ]}
            />
          </>
        ) : (
          <p role="status">현재 긴급 정지 상태를 확인할 수 없습니다.</p>
        )}
      </SectionCard>

      <SectionCard title="공급자 장애 감지 · 최근 7일" description="공급자별 폴백·5xx 집중 구간입니다.">
        {incidents.isError ? (
          <PanelFailure
            error={incidents.error}
            hasData={Boolean(incidents.data)}
            label="공급자 장애 감지"
            onRetry={() => void incidents.refetch()}
          />
        ) : null}
        <GovernanceTable
          caption="최근 7일 공급자 장애 후보"
          columns={incidentColumns}
          rows={incidentRows}
          loading={incidents.isPending}
          emptyMessage="최근 7일 동안 감지된 공급자 장애가 없습니다."
        />
      </SectionCard>

      <ConfirmDialog
        key={review?.id ?? "closed"}
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            active.current = undefined;
            setReview(undefined);
          }
        }}
        returnFocusRef={triggerRef}
        title={confirming === "stop" ? "게이트웨이를 긴급 정지할까요?" : "정상 운영을 재개할까요?"}
        description={confirming === "stop" ? killSwitchMessages.stop : killSwitchMessages.resume}
        confirmLabel={confirming === "stop" ? "긴급 차단" : "운영 재개"}
        confirmDisabled={!access.allowed || !stateReady || !baselineMatches || sent}
        tone="danger"
        requireReason
        requireTarget={targetText[confirming ?? "stop"]}
        onConfirm={async (reason, target) => {
          access.assertCurrent();
          if (
            !confirming ||
            target !== targetText[confirming] ||
            reason.trim() === "" ||
            review === undefined
          )
            throw new AppError("대상 확인 문구와 변경 사유를 입력하세요.", { kind: "aborted" });
          assertSelected(review);
          query.assertState(review.snapshot);
          await setKillSwitch.mutateAsync({ review, disabled: confirming === "stop", reason: reason.trim() });
        }}
      >
        {sent && setKillSwitch.isError ? (
          <InlineNotice tone="warning" title={killSwitchMessages.uncertainTitle}>
            {killSwitchMessages.uncertain}
            <Button
              variant="secondary"
              disabled={killSwitch.isFetching}
              onClick={() => void killSwitch.refetch()}
            >
              현재 상태만 다시 조회
            </Button>
          </InlineNotice>
        ) : null}
        <KillSwitchTraffic traffic={review?.snapshot.data.traffic} stale={!stateReady || !baselineMatches} />
        {!stateReady || !baselineMatches ? (
          <InlineNotice tone="warning" title="변경 기준을 다시 확인하세요.">
            조회 기준이 바뀌었거나 불명확합니다. 취소 후 상태를 확인하고 다시 검토하세요.
          </InlineNotice>
        ) : null}
        {!access.allowed ? (
          <InlineNotice tone="warning" title="긴급 정지 변경이 잠겼습니다.">
            {access.reason} 입력한 사유는 유지됩니다. 권한이 복구되어도 직접 확인하기 전에는 전송하지
            않습니다.
          </InlineNotice>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
