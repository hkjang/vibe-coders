import { useState } from "react";

import type { NotificationConfig } from "@/shared/api/domains/system.schemas";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Input } from "@/shared/components/ui/Input";
import { Switch } from "@/shared/components/ui/Switch";

export interface NotificationSaveInput {
  enabled: boolean;
  channel: string;
  webhookUrl: string;
  events: readonly string[];
}

interface NotificationFormProps {
  config: NotificationConfig;
  hasAdminWrite: boolean;
  onSubmit: (input: NotificationSaveInput) => void;
  pending: boolean;
}

const eventLabels: Record<string, string> = {
  cost: "비용 경보",
  secret: "비밀정보 탐지",
  approval: "승인 요청",
  provider: "공급자 상태",
};

/**
 * Mounted with a key derived from the loaded config so a refetch (including the
 * one after saving) reseeds the form instead of syncing state in an effect.
 */
export function NotificationForm({
  config,
  hasAdminWrite,
  onSubmit,
  pending,
}: NotificationFormProps): React.JSX.Element {
  const [enabled, setEnabled] = useState(config.enabled === true);
  const [channel, setChannel] = useState(config.channel ?? "");
  const [events, setEvents] = useState<readonly string[]>(config.events ?? []);
  // The stored webhook URL embeds a token, so it is never loaded into the form.
  const [webhookUrl, setWebhookUrl] = useState("");

  const availableEvents = config.available_events ?? ["cost", "secret", "approval", "provider"];

  return (
    <form
      className="form-grid"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ enabled, channel, webhookUrl, events });
      }}
    >
      <div className="settings-badge-row">
        <Switch checked={enabled} disabled={!hasAdminWrite} label="알림 사용" onCheckedChange={setEnabled} />
        <Badge tone={config.webhook_url ? "success" : "muted"}>
          {config.webhook_url ? "Webhook 설정됨" : "Webhook 미설정"}
        </Badge>
      </div>

      <FormField
        label="Webhook 주소"
        description="입력 전용입니다. 저장된 주소는 토큰을 포함하므로 표시하지 않습니다. 비워 두면 기존 주소를 유지합니다."
      >
        {(control) => (
          <Input
            {...control}
            type="password"
            autoComplete="off"
            value={webhookUrl}
            disabled={!hasAdminWrite}
            placeholder="새 Webhook 주소를 입력하면 교체됩니다"
            onChange={(event) => setWebhookUrl(event.target.value)}
          />
        )}
      </FormField>

      <FormField label="채널" description="비워 두면 Webhook의 기본 채널을 사용합니다.">
        {(control) => (
          <Input
            {...control}
            value={channel}
            disabled={!hasAdminWrite}
            onChange={(event) => setChannel(event.target.value)}
          />
        )}
      </FormField>

      <fieldset className="settings-fieldset">
        <legend>보낼 이벤트</legend>
        {availableEvents.map((event) => (
          <Checkbox
            key={event}
            label={eventLabels[event] ?? event}
            checked={events.includes(event)}
            disabled={!hasAdminWrite}
            onChange={(changeEvent) =>
              setEvents((current) =>
                changeEvent.target.checked ? [...current, event] : current.filter((item) => item !== event),
              )
            }
          />
        ))}
      </fieldset>

      <div className="settings-form-actions">
        <Button type="submit" variant="primary" disabled={!hasAdminWrite || pending}>
          {pending ? "저장 중" : "알림 설정 저장"}
        </Button>
        {hasAdminWrite ? null : <p className="settings-permission-note">admin:write 권한이 필요합니다.</p>}
      </div>
    </form>
  );
}
