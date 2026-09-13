import { ShieldCheck, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";

import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import {
  routeId,
  systemSettingsKeys,
  useTrackingStatus,
} from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const system = endpoints.domains.system;

/** Where the tracking settings themselves live: the runtime tab, filtered to the category. */
const settingsHref = "/system/settings?tab=runtime&category=tracking";

const providerLabels: Record<string, string> = {
  none: "사용 안 함",
  momento: "Momento (사내 수집기)",
  ga4: "Google Analytics 4",
  gtm: "Google Tag Manager",
  matomo: "Matomo",
  custom: "직접 붙여넣은 스니펫",
};

export function TrackingTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
  const status = useTrackingStatus();
  const clearTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const data = status.data;
  const violations = data?.violations ?? [];
  const blocked = violations.filter((violation) => !violation.allowed);

  const allow = useMutationFeedback({
    mutate: async (origin: string) => apiClient.request(system.tracking.allow, { body: { origin }, routeId }),
    invalidates: [systemSettingsKeys.tracking, systemSettingsKeys.effective],
    successMessage: "허용 목록에 추가했습니다. 다음 페이지 로드부터 적용됩니다.",
    errorMessage: "허용 목록에 추가하지 못했습니다.",
  });

  const clear = useMutationFeedback({
    mutate: async () => apiClient.request(system.tracking.clear, { routeId }),
    invalidates: [systemSettingsKeys.tracking],
    successMessage: "차단 기록을 비웠습니다.",
    errorMessage: "차단 기록을 비우지 못했습니다.",
  });

  return (
    <div className="settings-tab-stack">
      {status.isError ? (
        <QueryNotice
          error={status.error}
          hasPreviousData={Boolean(status.data)}
          label="방문 추적 상태"
          onRetry={() => void status.refetch()}
        />
      ) : null}
      {status.isPending ? <p role="status">방문 추적 상태를 불러오는 중입니다.</p> : null}

      {data ? (
        <SectionCard
          title="현재 상태"
          headingLevel={3}
          description="스니펫은 런타임 설정의 tracking 범주에서 켜고 끕니다. 기본값은 꺼짐입니다."
          actions={
            <Link className="button button-secondary button-small" to={settingsHref}>
              추적 설정 열기
            </Link>
          }
        >
          <KeyValueList
            columns={3}
            items={[
              {
                label: "삽입",
                value: data.active ? (
                  <Badge tone="success">켜짐</Badge>
                ) : data.enabled ? (
                  <Badge tone="warning">켜졌지만 미완성</Badge>
                ) : (
                  <Badge tone="muted">꺼짐</Badge>
                ),
              },
              { label: "도구", value: providerLabels[data.provider] ?? data.provider },
              {
                label: "Momento 프록시",
                value:
                  data.provider === "momento"
                    ? data.momento_proxy
                      ? "같은 오리진(/momento)"
                      : "직접 연결"
                    : "—",
              },
              { label: "위치", value: data.placement === "body" ? "body 끝" : "head 끝" },
              { label: "기존 관리자 콘솔(/admin)", value: data.include_admin ? "포함" : "제외" },
              {
                label: "추가 허용 출처",
                value: data.allowed_hosts?.length ? data.allowed_hosts.join(", ") : "없음",
                mono: true,
              },
            ]}
          />
          {data.error ? (
            <InlineNotice tone="warning" title="설정이 아직 완성되지 않아 스니펫이 들어가지 않습니다.">
              <code>{data.error}</code>
            </InlineNotice>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard
        title="브라우저가 차단한 출처"
        headingLevel={3}
        description="추적이 켜져 있는 동안 콘텐츠 보안 정책(CSP)이 막은 주소입니다. 스니펫이 조용히 멈췄다면 여기 이유가 남습니다. 허용을 누르면 tracking.allowed_hosts 에 더해져 다음 페이지 로드부터 정책이 그 출처를 받아들입니다."
        actions={
          <Button
            ref={clearTriggerRef}
            size="small"
            disabled={!hasAdminWrite || violations.length === 0 || clear.isPending}
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 aria-hidden="true" /> 기록 비우기
          </Button>
        }
      >
        {!status.isPending && violations.length === 0 ? (
          <EmptyState
            title="차단된 출처가 없습니다."
            description={
              data?.active
                ? "스니펫이 정책 안에서 정상 동작하고 있습니다."
                : "추적을 켜면 브라우저가 차단한 출처가 이곳에 모입니다."
            }
          />
        ) : (
          <table className="data-table">
            <caption className="sr-only">차단된 출처</caption>
            <thead>
              <tr>
                <th scope="col">출처</th>
                <th scope="col">지시어</th>
                <th scope="col">페이지</th>
                <th scope="col">횟수</th>
                <th scope="col">마지막</th>
                <th scope="col">상태</th>
              </tr>
            </thead>
            <tbody>
              {status.isPending ? (
                <tr>
                  <td colSpan={6} className="data-table-state">
                    <span role="status">차단 기록을 불러오는 중입니다.</span>
                  </td>
                </tr>
              ) : (
                violations.map((violation) => (
                  <tr key={`${violation.directive} ${violation.origin}`}>
                    <td className="mono">{violation.origin}</td>
                    <td className="mono">{violation.directive}</td>
                    <td className="mono">{violation.page || "—"}</td>
                    <td>{formatNumber(violation.count)}</td>
                    <td>{formatDateTime(violation.last_seen)}</td>
                    <td>
                      {violation.allowed ? (
                        <Badge tone="success">허용됨</Badge>
                      ) : (
                        <Button
                          size="small"
                          variant="primary"
                          disabled={!hasAdminWrite || allow.isPending}
                          onClick={() => allow.mutate(violation.origin)}
                          aria-label={`${violation.origin} 허용`}
                        >
                          <ShieldCheck aria-hidden="true" /> 허용
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
        {blocked.length > 0 ? (
          <p className="settings-permission-note">
            아직 막힌 출처 {formatNumber(blocked.length)}개. 허용한 뒤에도 남아 있으면 기록을 비우고 페이지를
            다시 열어 확인하세요.
          </p>
        ) : null}
        <UpdatedAt at={status.dataUpdatedAt} />
      </SectionCard>

      <SectionCard title="정책은 어떻게 열리나" headingLevel={3}>
        <ul className="settings-delegated-list">
          <li>
            <span>
              요청마다 새 nonce 를 만들어 스니펫의 모든 <code>&lt;script&gt;</code> 에 붙이고 같은 값을{" "}
              <code>script-src</code> 에 넣습니다. <code>&#39;unsafe-inline&#39;</code> 은 쓰지 않습니다.
            </span>
          </li>
          <li>
            <span>
              스니펫 안의 http(s) 출처는 자동으로 <code>script-src</code> · <code>connect-src</code> ·{" "}
              <code>img-src</code> 에 더해집니다. 자동으로 못 읽은 출처는 위 표에서 허용합니다.
            </span>
          </li>
          <li>
            <span>
              Momento 는 같은 오리진 프록시(<code>/momento/*</code>)를 기본으로 써서 외부 출처가 정책에
              등장하지 않습니다. 추적을 끄면 정책은 원래대로 좁아집니다.
            </span>
          </li>
        </ul>
      </SectionCard>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="차단 기록 비우기"
        description="기록된 차단 출처를 모두 지웁니다. 스니펫을 고친 뒤 무엇이 아직 막히는지 다시 보려는 용도입니다."
        confirmLabel="비우기"
        tone="danger"
        returnFocusRef={clearTriggerRef}
        onConfirm={async () => {
          await clear.mutateAsync(undefined);
        }}
      />
    </div>
  );
}
