import { useRef, useState } from "react";

import { NotificationForm, type NotificationSaveInput } from "@/features/system/settings/NotificationForm";
import { QueryNotice } from "@/features/system/settings/SettingsParts";
import {
  routeId,
  systemSettingsKeys,
  useFallbackStats,
  useNotificationConfig,
  useRetentionStatus,
} from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatBytes, formatDateTime, formatNumber } from "@/shared/utils/format";

const system = endpoints.domains.system;

export function OperationsTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
  const retention = useRetentionStatus();
  const fallback = useFallbackStats();
  const notifications = useNotificationConfig();
  const retentionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const fallbackTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [confirmRetention, setConfirmRetention] = useState(false);
  const [confirmFallback, setConfirmFallback] = useState(false);

  const runRetention = useMutationFeedback({
    mutate: async () => apiClient.request(system.retention.run, { routeId }),
    invalidates: [systemSettingsKeys.retention],
    successMessage: "보존 정책에 따라 오래된 데이터를 정리했습니다.",
    errorMessage: "데이터 정리를 실행하지 못했습니다.",
  });

  const replayFallback = useMutationFeedback({
    mutate: async () => apiClient.request(system.fallback.replay, { routeId }),
    invalidates: [systemSettingsKeys.fallback],
    successMessage: "Fallback 로그를 DB로 재처리했습니다.",
    errorMessage: "Fallback 로그를 재처리하지 못했습니다.",
  });

  const saveNotifications = useMutationFeedback({
    mutate: async (input: NotificationSaveInput) =>
      apiClient.request(system.notifications.save, {
        body: {
          enabled: input.enabled,
          channel: input.channel,
          events: input.events,
          // Only send the webhook when the operator typed a new one.
          ...(input.webhookUrl ? { webhook_url: input.webhookUrl } : {}),
        },
        routeId,
      }),
    invalidates: [systemSettingsKeys.notifications],
    successMessage: "알림 설정을 저장했습니다.",
    errorMessage: "알림 설정을 저장하지 못했습니다.",
  });

  const testNotification = useMutationFeedback({
    mutate: async () => apiClient.request(system.notifications.test, { routeId }),
    successMessage: "테스트 메시지를 발송했습니다.",
    errorMessage: "테스트 메시지를 발송하지 못했습니다.",
  });

  const writeNote = hasAdminWrite ? undefined : "admin:write 권한이 필요합니다.";

  return (
    <div className="settings-tab-stack">
      <SectionCard
        title="데이터 보존 정책"
        headingLevel={3}
        description="보존 기간이 지난 요청·프롬프트·응답을 정리합니다."
        actions={
          <Button
            ref={retentionTriggerRef}
            variant="danger"
            size="small"
            disabled={!hasAdminWrite || runRetention.isPending}
            onClick={() => setConfirmRetention(true)}
          >
            지금 정리 실행
          </Button>
        }
      >
        {retention.isError ? (
          <QueryNotice
            error={retention.error}
            hasPreviousData={Boolean(retention.data)}
            label="데이터 보존 정책"
            onRetry={() => void retention.refetch()}
          />
        ) : null}
        {retention.isPending ? <p role="status">보존 정책을 불러오는 중입니다.</p> : null}
        {retention.data ? (
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
              { label: "마지막 삭제 건수", value: formatNumber(retention.data.last_deleted) },
            ]}
          />
        ) : null}
        {writeNote ? <p className="settings-permission-note">{writeNote}</p> : null}
      </SectionCard>

      <SectionCard
        title="Fallback 로그 재처리"
        headingLevel={3}
        description="DB 저장에 실패해 파일로 남은 요청 로그를 다시 적재합니다."
        actions={
          <Button
            ref={fallbackTriggerRef}
            size="small"
            disabled={!hasAdminWrite || replayFallback.isPending}
            onClick={() => setConfirmFallback(true)}
          >
            DB로 재처리
          </Button>
        }
      >
        {fallback.isError ? (
          <QueryNotice
            error={fallback.error}
            hasPreviousData={Boolean(fallback.data)}
            label="Fallback 로그"
            onRetry={() => void fallback.refetch()}
          />
        ) : null}
        {fallback.isPending ? <p role="status">Fallback 로그 상태를 불러오는 중입니다.</p> : null}
        {fallback.data ? (
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
        {replayFallback.data ? (
          <InlineNotice tone="success" title="재처리 결과">
            적재 {formatNumber(replayFallback.data.imported)}건 · 중복{" "}
            {formatNumber(replayFallback.data.duplicates)}건 · 실패 {formatNumber(replayFallback.data.failed)}
            건 · 남은 줄 {formatNumber(replayFallback.data.remaining)}
          </InlineNotice>
        ) : null}
      </SectionCard>

      <SectionCard
        title="알림 Webhook (Mattermost)"
        headingLevel={3}
        description="비용·비밀정보·승인·공급자 이벤트를 채널로 보냅니다."
        actions={
          <Button
            size="small"
            disabled={!hasAdminWrite || testNotification.isPending}
            onClick={() => testNotification.mutate(undefined)}
          >
            테스트 메시지 발송
          </Button>
        }
      >
        {notifications.isError ? (
          <QueryNotice
            error={notifications.error}
            hasPreviousData={Boolean(notifications.data)}
            label="알림 설정"
            onRetry={() => void notifications.refetch()}
          />
        ) : null}
        {notifications.isPending ? <p role="status">알림 설정을 불러오는 중입니다.</p> : null}
        {notifications.data ? (
          <NotificationForm
            key={notifications.dataUpdatedAt}
            config={notifications.data}
            hasAdminWrite={hasAdminWrite}
            onSubmit={(input) => saveNotifications.mutate(input)}
            pending={saveNotifications.isPending}
          />
        ) : null}
      </SectionCard>

      <ConfirmDialog
        open={confirmRetention}
        onOpenChange={setConfirmRetention}
        title="지금 정리 실행"
        description="보존 기간이 지난 요청·프롬프트·응답을 즉시 삭제합니다. 삭제한 데이터는 복구할 수 없습니다."
        confirmLabel="정리 실행"
        tone="danger"
        requireReason
        returnFocusRef={retentionTriggerRef}
        onConfirm={async () => {
          await runRetention.mutateAsync(undefined);
        }}
      />

      <ConfirmDialog
        open={confirmFallback}
        onOpenChange={setConfirmFallback}
        title="Fallback 로그 재처리"
        description="파일에 남은 요청 로그를 DB로 다시 적재합니다. 이미 적재된 항목은 중복으로 건너뜁니다."
        confirmLabel="재처리 실행"
        returnFocusRef={fallbackTriggerRef}
        onConfirm={async () => {
          await replayFallback.mutateAsync(undefined);
        }}
      />
    </div>
  );
}
