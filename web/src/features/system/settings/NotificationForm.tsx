import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useInlineSettingsDraft } from "@/features/system/settings/use-inline-settings-draft";
import { routeId, systemSettingsKeys } from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import type { NotificationConfig } from "@/shared/api/domains/system.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Switch } from "@/shared/components/ui/Switch";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

const eventLabels: Record<string, string> = {
  cost: "비용 경보",
  secret: "비밀정보 탐지",
  approval: "승인 요청",
  provider: "공급자 상태",
};

function fromConfig(config: NotificationConfig) {
  return {
    enabled: config.enabled === true,
    channel: config.channel ?? "",
    events: [...(config.events ?? [])].sort(),
    // Never seed this input with a stored or masked webhook.
    webhookUrl: "",
    clearWebhook: false,
  };
}

interface NotificationFormProps {
  config: NotificationConfig;
  hasAdminWrite: boolean;
}

export function NotificationForm(props: NotificationFormProps): React.JSX.Element {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <NotificationEditor {...props} />
  ) : (
    <UnsavedChangesProvider>
      <NotificationEditor {...props} />
    </UnsavedChangesProvider>
  );
}

function NotificationEditor({ config, hasAdminWrite }: NotificationFormProps): React.JSX.Element {
  const client = useQueryClient();
  const [error, setError] = useState<string>();
  const editor = useInlineSettingsDraft({ config, fromConfig, onDiscard: () => setError(undefined) });
  const { draft, update, guard } = editor;
  const availableEvents = config.available_events ?? ["cost", "secret", "approval", "provider"];
  const save = (): void => {
    if (!hasAdminWrite || guard.pending) return;
    const webhook = draft.webhookUrl.trim();
    if (draft.webhookUrl && (!webhook || /[*•]{3,}/.test(webhook) || webhook === config.webhook_url)) {
      setError(
        "마스킹된 주소나 공백만 저장할 수 없습니다. 새 웹훅 주소를 입력하거나 명시적으로 지우기를 선택하세요.",
      );
      return;
    }
    setError(undefined);
    void guard.run(
      () =>
        apiClient.request(endpoints.domains.system.notifications.save, {
          routeId,
          body: {
            enabled: draft.enabled,
            channel: draft.channel,
            events: draft.events,
            ...(draft.clearWebhook ? { webhook_url: "" } : webhook ? { webhook_url: webhook } : {}),
          },
        }),
      (cause) => setError(safeAppErrorMessage(cause, "알림 설정을 저장하지 못했습니다.")),
      (result) => {
        // Cancel pre-commit reads before publishing this accepted snapshot.
        // Cancellation is synchronous; do not introduce an auth-sensitive await.
        void client.cancelQueries({ queryKey: systemSettingsKeys.notifications, exact: true });
        // Defense in depth: never retain a raw webhook returned by an older server.
        const latest = { ...result, webhook_url: result.webhook_url ? "********" : "" };
        client.setQueryData(systemSettingsKeys.notifications, latest);
        editor.rebase(latest);
        setError(undefined);
        toast.success("알림 설정을 저장했습니다.");
      },
    );
  };
  return (
    <form
      className="form-grid"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {editor.serverChanged ? (
        <InlineNotice tone="warning" title="서버의 알림 설정이 변경되었습니다.">
          편집 중인 초안은 유지합니다. 변경 취소 후 최신 값을 검토하세요. 이 설정은 동시 편집 충돌을 자동으로
          차단하지 않습니다.
        </InlineNotice>
      ) : null}
      <fieldset
        className="form-grid form-dialog-fields"
        aria-label="알림 입력 항목"
        disabled={!hasAdminWrite || guard.pending}
      >
        <div className="settings-badge-row">
          <Switch
            checked={draft.enabled}
            label="알림 사용"
            onCheckedChange={(value) => update("enabled", value)}
          />
          <Badge tone={config.webhook_url_set || config.webhook_url ? "success" : "muted"}>
            {config.webhook_url_set || config.webhook_url ? "웹훅 설정됨" : "웹훅 미설정"}
          </Badge>
        </div>
        <FormField
          label="웹훅 주소"
          description="입력 전용입니다. 저장된 주소는 토큰을 포함하므로 표시하지 않습니다. 비워 두면 기존 주소를 유지합니다."
        >
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="new-password"
              value={draft.webhookUrl}
              disabled={draft.clearWebhook}
              placeholder="새 웹훅 주소를 입력하면 교체됩니다"
              onChange={(event) => update("webhookUrl", event.target.value)}
            />
          )}
        </FormField>
        <Checkbox
          label="저장된 웹훅 주소 지우기"
          checked={draft.clearWebhook}
          onChange={(event) => {
            update("clearWebhook", event.target.checked);
            if (event.target.checked) update("webhookUrl", "");
          }}
        />
        <FormField label="채널" description="비워 두면 웹훅의 기본 채널을 사용합니다.">
          {(control) => (
            <Input
              {...control}
              value={draft.channel}
              onChange={(event) => update("channel", event.target.value)}
            />
          )}
        </FormField>
        <fieldset className="settings-fieldset">
          <legend>보낼 이벤트</legend>
          {availableEvents.map((event) => (
            <Checkbox
              key={event}
              label={eventLabels[event] ?? event}
              checked={draft.events.includes(event)}
              onChange={(changeEvent) =>
                update(
                  "events",
                  changeEvent.target.checked
                    ? [...draft.events, event].sort()
                    : draft.events.filter((item) => item !== event),
                )
              }
            />
          ))}
        </fieldset>
      </fieldset>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="settings-form-actions">
        <Button type="submit" variant="primary" disabled={!hasAdminWrite || guard.pending}>
          {guard.pending ? "저장 중" : "알림 설정 저장"}
        </Button>
        <Button disabled={!hasAdminWrite || guard.pending} onClick={() => guard.requestClose()}>
          변경 취소
        </Button>
        {!hasAdminWrite ? <p className="settings-permission-note">admin:write 권한이 필요합니다.</p> : null}
      </div>
    </form>
  );
}
