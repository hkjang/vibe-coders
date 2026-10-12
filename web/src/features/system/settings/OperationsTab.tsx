import { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { tokenStore } from "@/shared/auth/token-store";

import { NotificationForm } from "@/features/system/settings/NotificationForm";
import { QueryNotice } from "@/features/system/settings/SettingsParts";
import {
  routeId,
  systemSettingsKeys,
  useFallbackStats,
  useNotificationConfig,
  useRetentionStatus,
} from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import { AppError, isAppError } from "@/shared/api/error";
import { endpoints } from "@/shared/api/endpoints";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { formatBytes, formatDateTime, formatNumber } from "@/shared/utils/format";

const system = endpoints.domains.system;
const accessDenied = (error: unknown): boolean =>
  isAppError(error) &&
  (error.kind === "auth" || error.kind === "permission" || error.status === 401 || error.status === 403);

export function OperationsTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
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
    return <InlineNotice tone="warning">현재 계정과 화면에서 운영 작업을 조회할 수 없습니다.</InlineNotice>;
  return <OwnedOperationsTab key={owner} owner={owner} hasAdminWrite={hasAdminWrite} />;
}

function OwnedOperationsTab({
  owner,
  hasAdminWrite,
}: {
  owner: string;
  hasAdminWrite: boolean;
}): React.JSX.Element {
  const access = useFeatureMutationAccess([routeId], hasAdminWrite, "admin:write 권한이 필요합니다.");
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const retention = useRetentionStatus(owner);
  const fallback = useFallbackStats(owner);
  const notifications = useNotificationConfig(owner);
  const [revoked, setRevoked] = useState(false);
  const denied = revoked || [retention.error, fallback.error, notifications.error].some(accessDenied);
  // These endpoints share one authorization boundary. A successful sibling
  // refetch must not restore access after another endpoint detected revocation.
  if (denied && !revoked) setRevoked(true);
  const deniedRef = useRef(denied);
  useLayoutEffect(() => {
    deniedRef.current = denied;
  }, [denied]);
  const ownsResult = () => mounted.current && !deniedRef.current;
  const retentionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const fallbackTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [retentionReview, setRetentionReview] = useState<number>();
  const [fallbackReview, setFallbackReview] = useState<number>();
  const [retentionAttempt, setRetentionAttempt] = useState<number>();
  const [fallbackAttempt, setFallbackAttempt] = useState<number>();
  const retentionSent = retentionAttempt === retention.dataUpdatedAt;
  const fallbackSent = fallbackAttempt === fallback.dataUpdatedAt;
  const retentionReady = !denied && retention.isSuccess && !retention.isFetching;
  const fallbackReady = !denied && fallback.isSuccess && !fallback.isFetching;
  const retentionCurrent = retentionReady && !retentionSent && retentionReview === retention.dataUpdatedAt;
  const fallbackCurrent = fallbackReady && !fallbackSent && fallbackReview === fallback.dataUpdatedAt;
  const notificationSending = useRef(false);

  const runRetention = useMutationFeedback({
    ownsResult,
    mutate: async (reason: string) => {
      access.assertCurrent();
      if (!retentionCurrent)
        throw new AppError("최신 상태를 확인하고 정리 확인창을 다시 여세요.", { kind: "aborted" });
      setRetentionAttempt(retention.dataUpdatedAt);
      return apiClient.request(system.retention.run, { body: { reason }, routeId, retryUnauthorized: false });
    },
    invalidates: [systemSettingsKeys.retention],
    successMessage: "보존 정책에 따라 오래된 데이터를 정리했습니다.",
    errorMessage: "데이터 정리를 실행하지 못했습니다.",
  });

  const replayFallback = useMutationFeedback({
    ownsResult,
    mutate: async (reason: string) => {
      access.assertCurrent();
      if (!fallbackCurrent)
        throw new AppError("최신 상태를 확인하고 재처리 확인창을 다시 여세요.", { kind: "aborted" });
      setFallbackAttempt(fallback.dataUpdatedAt);
      return apiClient.request(system.fallback.replay, {
        body: { reason },
        routeId,
        retryUnauthorized: false,
      });
    },
    invalidates: [systemSettingsKeys.fallback],
    successMessage: "저장 실패 로그를 DB로 재처리했습니다.",
    errorMessage: "저장 실패 로그를 재처리하지 못했습니다.",
  });

  const testNotification = useMutationFeedback({
    ownsResult,
    mutate: async () => {
      access.assertCurrent();
      return apiClient.request(system.notifications.test, { routeId, retryUnauthorized: false });
    },
    successMessage: "테스트 메시지를 발송했습니다.",
    errorMessage: "테스트 메시지를 발송하지 못했습니다.",
  });

  const writeNote = access.reason;

  return (
    <div className="settings-tab-stack">
      {denied ? (
        <InlineNotice tone="warning">
          운영 작업 조회 권한이 거부되어 이 탭의 데이터와 실행을 잠갔습니다. 다시 로그인하거나 화면을 다시
          열어 권한을 확인하세요.
        </InlineNotice>
      ) : null}
      <SectionCard
        title="데이터 보존 정책"
        headingLevel={3}
        description="보존 기간이 지난 요청·프롬프트·응답을 정리합니다."
        actions={
          <Button
            ref={retentionTriggerRef}
            variant="danger"
            size="small"
            disabled={!access.allowed || !retentionReady || retentionSent || runRetention.isPending}
            title={writeNote}
            onClick={() => setRetentionReview(retention.dataUpdatedAt)}
          >
            지금 정리 실행
          </Button>
        }
      >
        {retention.isError ? (
          <QueryNotice
            error={retention.error}
            hasPreviousData={!denied && Boolean(retention.data)}
            label="데이터 보존 정책"
            onRetry={() => void retention.refetch()}
          />
        ) : null}
        {retention.isPending ? <p role="status">보존 정책을 불러오는 중입니다.</p> : null}
        {!denied && retention.data ? (
          <KeyValueList
            columns={3}
            items={[
              { label: "요청 보존일", value: `${formatNumber(retention.data.request_days)}일` },
              { label: "프롬프트 보존일", value: `${formatNumber(retention.data.prompt_days)}일` },
              { label: "응답 보존일", value: `${formatNumber(retention.data.response_days)}일` },
              { label: "저장된 요청", value: formatNumber(retention.data.requests) },
              { label: "저장된 프롬프트", value: formatNumber(retention.data.prompts) },
              { label: "저장된 응답", value: formatNumber(retention.data.responses) },
              { label: "마지막 정리", value: formatDateTime(retention.data.last_run_at) },
              { label: "현재 프로세스 누적 삭제", value: formatNumber(retention.data.last_deleted) },
            ]}
          />
        ) : null}
        {writeNote ? <p className="settings-permission-note">{writeNote}</p> : null}
      </SectionCard>

      <SectionCard
        title="저장 실패 로그 재처리"
        headingLevel={3}
        description="DB 저장에 실패해 파일로 남은 요청 로그를 다시 적재합니다."
        actions={
          <Button
            ref={fallbackTriggerRef}
            size="small"
            disabled={!access.allowed || !fallbackReady || fallbackSent || replayFallback.isPending}
            title={writeNote}
            onClick={() => setFallbackReview(fallback.dataUpdatedAt)}
          >
            DB로 재처리
          </Button>
        }
      >
        {fallback.isError ? (
          <QueryNotice
            error={fallback.error}
            hasPreviousData={!denied && Boolean(fallback.data)}
            label="저장 실패 로그"
            onRetry={() => void fallback.refetch()}
          />
        ) : null}
        {fallback.isPending ? <p role="status">저장 실패 로그 상태를 불러오는 중입니다.</p> : null}
        {!denied && fallback.data ? (
          <KeyValueList
            columns={3}
            items={[
              { label: "파일 경로", value: fallback.data.path, mono: true },
              { label: "파일 존재", value: fallback.data.exists ? "있음" : "없음" },
              { label: "대기 줄 수", value: formatNumber(fallback.data.lines) },
              { label: "크기", value: formatBytes(fallback.data.bytes ?? 0) },
              { label: "수정 시각", value: formatDateTime(fallback.data.modified_at) },
            ]}
          />
        ) : null}
        {!denied && replayFallback.data ? (
          <InlineNotice tone="success" title="재처리 결과">
            적재 {formatNumber(replayFallback.data.imported)}건 · 중복{" "}
            {formatNumber(replayFallback.data.duplicates)}건 · 실패 {formatNumber(replayFallback.data.failed)}
            건 · 남은 줄 {formatNumber(replayFallback.data.remaining)}
          </InlineNotice>
        ) : null}
      </SectionCard>

      <SectionCard
        title="알림 웹훅 (Mattermost)"
        headingLevel={3}
        description="비용·비밀정보·승인·공급자 이벤트를 채널로 보냅니다. 테스트 메시지는 저장된 설정을 사용하며 초안을 저장하지 않습니다."
        actions={
          <Button
            size="small"
            disabled={!access.allowed || denied || testNotification.isPending}
            title={writeNote}
            onClick={() => {
              if (notificationSending.current) return;
              notificationSending.current = true;
              void testNotification
                .mutateAsync(undefined)
                .catch(() => undefined)
                .finally(() => {
                  notificationSending.current = false;
                });
            }}
          >
            테스트 메시지 발송
          </Button>
        }
      >
        {notifications.isError ? (
          <QueryNotice
            error={notifications.error}
            hasPreviousData={!denied && Boolean(notifications.data)}
            label="알림 설정"
            onRetry={() => void notifications.refetch()}
          />
        ) : null}
        {notifications.isPending ? <p role="status">알림 설정을 불러오는 중입니다.</p> : null}
        {!denied && notifications.data ? (
          <NotificationForm
            config={notifications.data}
            hasAdminWrite={access.allowed}
            queryKey={[...systemSettingsKeys.notifications, owner]}
          />
        ) : null}
      </SectionCard>

      {retentionSent || fallbackSent ? (
        <InlineNotice tone="warning" title="전송한 작업의 상태를 확인하세요">
          실패하거나 응답이 없어도 일부 작업이 완료됐을 수 있습니다. 즉시 다시 실행하지 말고 상태를
          새로고침하고 감사 기록을 확인하세요.
        </InlineNotice>
      ) : null}

      <ConfirmDialog
        open={retentionReview !== undefined}
        onOpenChange={(open) => {
          if (!open) setRetentionReview(undefined);
        }}
        title="지금 정리 실행"
        description="보존 기간이 지난 요청·프롬프트·응답을 즉시 삭제합니다. 삭제한 데이터는 복구할 수 없습니다."
        confirmLabel="정리 실행"
        tone="danger"
        requireReason
        requireTarget="데이터 정리"
        confirmDisabled={!access.allowed || !retentionCurrent}
        returnFocusRef={retentionTriggerRef}
        onConfirm={async (reason) => {
          await runRetention.mutateAsync(reason);
        }}
      >
        <p>저장된 전체 건수는 삭제 예정 건수가 아닙니다. 필요한 백업을 먼저 확인하세요.</p>
        {!retentionCurrent ? (
          <p role="status">
            상태가 다시 조회되었거나 확인되지 않았습니다. 최신 상태를 확인한 뒤 창을 닫고 다시 여세요.
          </p>
        ) : null}
        {writeNote ? <p>{writeNote}</p> : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={fallbackReview !== undefined}
        onOpenChange={(open) => {
          if (!open) setFallbackReview(undefined);
        }}
        title="저장 실패 로그 재처리"
        description="파일에 남은 요청 로그를 DB로 다시 적재합니다. 이미 적재된 항목은 중복으로 건너뜁니다."
        confirmLabel="재처리 실행"
        requireReason
        requireTarget="로그 재처리"
        confirmDisabled={!access.allowed || !fallbackCurrent}
        returnFocusRef={fallbackTriggerRef}
        onConfirm={async (reason) => {
          await replayFallback.mutateAsync(reason);
        }}
      >
        {!fallbackCurrent ? (
          <p role="status">
            상태가 다시 조회되었거나 확인되지 않았습니다. 최신 상태를 확인한 뒤 창을 닫고 다시 여세요.
          </p>
        ) : null}
        {writeNote ? <p>{writeNote}</p> : null}
      </ConfirmDialog>
    </div>
  );
}
