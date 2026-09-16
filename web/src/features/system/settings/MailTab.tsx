import { Send } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import { routeId, systemSettingsKeys, useMailStatus } from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import { FormField } from "@/shared/components/form/FormField";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const system = endpoints.domains.system;

/** Where the mail settings themselves live: the runtime tab, filtered to the category. */
const settingsHref = "/system/settings?tab=runtime&category=mail";

const eventLabels: Record<string, string> = {
  "approval.requested": "승인 대기 (관리자에게)",
  "approval.decided": "승인 결과 (요청자에게)",
  "key.blocked": "API 키 차단 (키 소유자에게)",
  "report.failed": "예약 리포트 실패 (작성자에게)",
  test: "시험 발송",
};

const switchLabels: Record<string, string> = {
  "mail.notify_approval": "승인 대기·결과",
  "mail.notify_key_blocked": "API 키 차단",
  "mail.notify_report": "예약 리포트 실패",
};

function statusBadge(status: string): React.JSX.Element {
  if (status === "sent") return <Badge tone="success">보냄</Badge>;
  if (status === "failed") return <Badge tone="danger">실패</Badge>;
  return <Badge tone="muted">대기</Badge>;
}

export function MailTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
  const status = useMailStatus();
  const [recipient, setRecipient] = useState("");
  const [lastResult, setLastResult] = useState<{ sent: boolean; recipient?: string; error?: string } | null>(
    null,
  );

  const data = status.data;
  const deliveries = data?.deliveries ?? [];

  const test = useMutationFeedback({
    mutate: async (to: string) =>
      apiClient.request(system.mail.test, { body: to ? { recipient: to } : {}, routeId }),
    invalidates: [systemSettingsKeys.mail],
    onSuccess: (result) => setLastResult(result),
    successMessage: "시험 메일을 보냈습니다. 받은 편지함을 확인하세요.",
    errorMessage: "시험 메일을 보내지 못했습니다. 아래 결과와 발송 기록의 사유를 확인하세요.",
  });

  return (
    <div className="settings-tab-stack">
      {status.isError ? (
        <QueryNotice
          error={status.error}
          hasPreviousData={Boolean(status.data)}
          label="메일 알림 상태"
          onRetry={() => void status.refetch()}
        />
      ) : null}
      {status.isPending ? <p role="status">메일 알림 상태를 불러오는 중입니다.</p> : null}

      {data ? (
        <SectionCard
          title="현재 상태"
          headingLevel={3}
          description="릴레이 주소·보내는 사람·이벤트 스위치는 런타임 설정의 mail 범주에서 바꿉니다. 기본값은 꺼짐이고, 사내 릴레이(포트 25·인증 없음)가 기본 모양입니다."
          actions={
            <Link className="button button-secondary button-small" to={settingsHref}>
              메일 설정 열기
            </Link>
          }
        >
          <KeyValueList
            columns={3}
            items={[
              {
                label: "발송",
                value: data.ready ? (
                  <Badge tone="success">켜짐</Badge>
                ) : data.enabled ? (
                  <Badge tone="warning">켜졌지만 미완성</Badge>
                ) : (
                  <Badge tone="muted">꺼짐</Badge>
                ),
              },
              {
                label: "릴레이",
                value: data.smtp_host
                  ? `${data.smtp_host}:${data.smtp_port ?? 25} (${data.security ?? "auto"})`
                  : "없음",
                mono: true,
              },
              { label: "보내는 사람", value: data.from || "—", mono: true },
              {
                label: "인증",
                value: data.username_set
                  ? data.password_set
                    ? "사용자 이름·비밀번호 설정됨"
                    : "사용자 이름만 설정됨"
                  : "없음(인증 없는 릴레이)",
              },
              { label: "링크 기준 주소", value: data.base_url || "없음(링크 생략)", mono: true },
              {
                label: "이벤트",
                value: Object.entries(data.events ?? {})
                  .map(([key, on]) => `${switchLabels[key] ?? key}: ${on ? "켬" : "끔"}`)
                  .join(" · "),
              },
            ]}
          />
          {data.error ? (
            <InlineNotice tone="warning" title="설정이 아직 완성되지 않아 메일이 나가지 않습니다.">
              <code>{data.error}</code>
            </InlineNotice>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard
        title="시험 발송"
        headingLevel={3}
        description="저장된 설정으로 실제 한 통을 보내고 결과를 그 자리에서 보여 줍니다. 릴레이 설정은 한 번에 맞는 일이 드뭅니다. 받는 사람을 비우면 로그인한 관리자 주소로 보냅니다."
      >
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            test.mutate(recipient.trim());
          }}
        >
          <FormField label="받는 사람" description="비우면 로그인한 관리자의 주소로 보냅니다.">
            {(control) => (
              <Input
                {...control}
                type="email"
                placeholder="you@corp.example"
                value={recipient}
                disabled={!hasAdminWrite || test.isPending}
                onChange={(event) => setRecipient(event.target.value)}
              />
            )}
          </FormField>
          <div className="settings-form-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={!hasAdminWrite || test.isPending || !data?.enabled}
            >
              <Send aria-hidden="true" /> 시험 메일 보내기
            </Button>
          </div>
        </form>
        {lastResult ? (
          <InlineNotice
            tone={lastResult.sent ? "success" : "danger"}
            title={lastResult.sent ? `${lastResult.recipient ?? ""} 으로 보냈습니다.` : "보내지 못했습니다."}
          >
            {lastResult.error ? <code>{lastResult.error}</code> : null}
          </InlineNotice>
        ) : null}
      </SectionCard>

      <SectionCard
        title="발송 기록"
        headingLevel={3}
        description="시도마다 남깁니다 — 성공도 실패도. 본문은 담지 않고 제목과 받는 사람만 남깁니다. '안 왔다'는 문의는 여기서 답합니다."
      >
        {!status.isPending && deliveries.length === 0 ? (
          <EmptyState
            title="발송 기록이 없습니다."
            description={
              data?.ready
                ? "아직 보낼 일이 없었습니다."
                : "메일을 켜고 시험 발송을 하면 기록이 이곳에 남습니다."
            }
          />
        ) : (
          <table className="data-table">
            <caption className="sr-only">발송 기록</caption>
            <thead>
              <tr>
                <th scope="col">시각</th>
                <th scope="col">이벤트</th>
                <th scope="col">받는 사람</th>
                <th scope="col">제목</th>
                <th scope="col">상태</th>
                <th scope="col">시도</th>
                <th scope="col">사유</th>
              </tr>
            </thead>
            <tbody>
              {status.isPending ? (
                <tr>
                  <td colSpan={7} className="data-table-state">
                    <span role="status">발송 기록을 불러오는 중입니다.</span>
                  </td>
                </tr>
              ) : (
                deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td>{formatDateTime(delivery.created_at)}</td>
                    <td>{eventLabels[delivery.event] ?? delivery.event}</td>
                    <td className="mono">{delivery.recipient}</td>
                    <td>{delivery.subject || "—"}</td>
                    <td>{statusBadge(delivery.status)}</td>
                    <td>{formatNumber(delivery.attempts ?? 0)}</td>
                    <td className="mono">{delivery.error_message || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
        {data?.total ? (
          <p className="settings-permission-note">
            전체 {formatNumber(data.total)}건 — 보냄 {formatNumber(data.counts?.sent ?? 0)} · 실패{" "}
            {formatNumber(data.counts?.failed ?? 0)}. 90일이 지난 기록은 자동으로 지워집니다.
          </p>
        ) : null}
        <UpdatedAt at={status.dataUpdatedAt} />
      </SectionCard>
    </div>
  );
}
