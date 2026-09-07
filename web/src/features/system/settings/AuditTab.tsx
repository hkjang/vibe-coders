import { Download } from "lucide-react";
import { useState } from "react";

import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import { useAuditLogs, useAuthEvents } from "@/features/system/settings/use-system-settings";
import { tokenStore } from "@/shared/auth/token-store";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime } from "@/shared/utils/format";

const limitOptions = ["50", "100", "200"] as const;
const csvLimit = 5000;

async function downloadAuditCsv(): Promise<void> {
  const token = tokenStore.getAccessToken() || tokenStore.getLegacyToken();
  const response = await fetch(`/admin/audit-logs.csv?limit=${csvLimit}`, {
    headers: {
      Accept: "text/csv",
      "X-Vibe-UI": "app",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function AuditTab(): React.JSX.Element {
  const [params, updateParams] = useSearchState();
  const requestedLimit = params.get("limit") ?? "";
  const limit = (limitOptions as readonly string[]).includes(requestedLimit) ? requestedLimit : "50";
  const logs = useAuditLogs(Number(limit));
  const events = useAuthEvents(Number(limit));
  const [downloadError, setDownloadError] = useState<string | undefined>();
  const [downloading, setDownloading] = useState(false);

  const logRows = logs.data?.audit_logs ?? [];
  const eventRows = events.data?.events ?? [];

  return (
    <div className="settings-tab-stack">
      <Toolbar
        label="변경 이력 필터"
        end={
          <Button
            size="small"
            disabled={downloading}
            onClick={() => {
              setDownloading(true);
              setDownloadError(undefined);
              void downloadAuditCsv()
                .catch(() => setDownloadError("감사 로그 CSV를 내려받지 못했습니다."))
                .finally(() => setDownloading(false));
            }}
          >
            <Download aria-hidden="true" /> 감사 로그 CSV 다운로드
          </Button>
        }
      >
        <label className="settings-filter">
          <span>표시 건수</span>
          <Select
            value={limit}
            onChange={(event) =>
              updateParams({ limit: event.target.value === "50" ? undefined : event.target.value })
            }
            options={limitOptions.map((option) => ({ value: option, label: `${option}건` }))}
          />
        </label>
      </Toolbar>

      {downloadError ? (
        <InlineNotice tone="danger" title="다운로드 실패">
          {downloadError}
        </InlineNotice>
      ) : null}

      <SectionCard
        title="관리자 변경 이력"
        headingLevel={3}
        description="설정과 자원 변경을 남긴 감사 기록입니다."
      >
        {logs.isError ? (
          <QueryNotice
            error={logs.error}
            hasPreviousData={Boolean(logs.data)}
            label="관리자 변경 이력"
            onRetry={() => void logs.refetch()}
          />
        ) : null}
        {!logs.isPending && logRows.length === 0 ? (
          <EmptyState
            title="기록된 변경 이력이 없습니다."
            description="설정을 저장하거나 자원을 만들면 이곳에 남습니다."
          />
        ) : (
          <table className="data-table">
            <caption className="sr-only">관리자 변경 이력</caption>
            <thead>
              <tr>
                <th scope="col">시각</th>
                <th scope="col">관리자</th>
                <th scope="col">작업</th>
                <th scope="col">변경 전</th>
                <th scope="col">변경 후</th>
              </tr>
            </thead>
            <tbody>
              {logs.isPending ? (
                <tr>
                  <td colSpan={5} className="data-table-state">
                    <span role="status">변경 이력을 불러오는 중입니다.</span>
                  </td>
                </tr>
              ) : (
                logRows.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDateTime(row.created_at)}</td>
                    <td>{row.admin_id || "—"}</td>
                    <td className="mono">{row.action || "—"}</td>
                    <td className="mono truncate">{row.before_value || "—"}</td>
                    <td className="mono truncate">{row.after_value || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
        <UpdatedAt at={logs.dataUpdatedAt} />
      </SectionCard>

      <SectionCard
        title="최근 인증 이벤트"
        headingLevel={3}
        description="로그인·SSO·토큰 관련 인증 기록입니다."
      >
        {events.isError ? (
          <QueryNotice
            error={events.error}
            hasPreviousData={Boolean(events.data)}
            label="인증 이벤트"
            onRetry={() => void events.refetch()}
          />
        ) : null}
        {!events.isPending && eventRows.length === 0 ? (
          <EmptyState
            title="기록된 인증 이벤트가 없습니다."
            description="로그인이 발생하면 이곳에 남습니다."
          />
        ) : (
          <table className="data-table">
            <caption className="sr-only">최근 인증 이벤트</caption>
            <thead>
              <tr>
                <th scope="col">시각</th>
                <th scope="col">유형</th>
                <th scope="col">사용자</th>
                <th scope="col">팀</th>
                <th scope="col">IP</th>
                <th scope="col">상세</th>
              </tr>
            </thead>
            <tbody>
              {events.isPending ? (
                <tr>
                  <td colSpan={6} className="data-table-state">
                    <span role="status">인증 이벤트를 불러오는 중입니다.</span>
                  </td>
                </tr>
              ) : (
                eventRows.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDateTime(row.created_at)}</td>
                    <td className="mono">{row.event_type || "—"}</td>
                    <td>{row.actor_user_id || "—"}</td>
                    <td>{row.team_id || "—"}</td>
                    <td className="mono">{row.ip || "—"}</td>
                    <td className="truncate">{row.detail || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </SectionCard>
    </div>
  );
}
