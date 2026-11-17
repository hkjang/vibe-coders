import { TableStateCell } from "@/shared/data-table/TableStateCell";
import { Download } from "lucide-react";
import { useRef } from "react";
import { useAuditCsvDownload } from "./use-audit-csv-download";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";

import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import { useAuditLogs, useAuthEvents } from "@/features/system/settings/use-system-settings";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime } from "@/shared/utils/format";

const limitOptions = ["50", "100", "200"] as const;
export function AuditTab(): React.JSX.Element {
  const owner = useFeatureReadOwner("system.settings", "audit-workspace");
  if (!owner.readable || owner.denied)
    return (
      <InlineNotice
        tone="danger"
        title="감사 기록 조회 권한 확인 필요"
        actions={owner.readable ? <Button onClick={owner.restart}>권한 확인 후 다시 조회</Button> : undefined}
      >
        이전 기록과 진행 중인 다운로드를 폐기했습니다. 관리자에게 admin:read 권한과 시스템 설정 접근 조건을
        확인해 달라고 요청하세요.
      </InlineNotice>
    );
  return <AuditWorkspace key={owner.id} owner={owner} />;
}

function AuditWorkspace({ owner }: { owner: FeatureReadOwner }): React.JSX.Element {
  const [params, updateParams] = useSearchState();
  const requestedLimit = params.get("limit") ?? "";
  const limit = (limitOptions as readonly string[]).includes(requestedLimit) ? requestedLimit : "50";
  const logs = useAuditLogs(Number(limit), owner);
  const events = useAuthEvents(Number(limit), owner);
  const download = useAuditCsvDownload(owner);
  const downloadButton = useRef<HTMLButtonElement>(null);
  const cancelDownload = () => {
    download.cancel();
    window.requestAnimationFrame(() => downloadButton.current?.focus());
  };

  const logRows = logs.data?.audit_logs ?? [];
  const eventRows = events.data?.events ?? [];

  return (
    <div className="settings-tab-stack">
      <Toolbar
        label="변경 이력 필터"
        end={
          <Button
            ref={downloadButton}
            size="small"
            disabled={download.pending}
            onClick={() => void download.start()}
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

      {download.pending ? (
        <InlineNotice
          title="감사 로그 CSV 준비 중"
          actions={
            <Button size="small" onClick={cancelDownload}>
              다운로드 취소
            </Button>
          }
        >
          감사 기록과 알림 기록을 각각 최대 5,000건 조회합니다. 화면을 떠나면 다운로드를 취소합니다.
        </InlineNotice>
      ) : null}
      {download.error ? (
        <QueryNotice
          error={download.error}
          hasPreviousData={false}
          label="감사 로그 CSV 다운로드"
          onRetry={() => void download.start()}
        />
      ) : null}
      {download.complete ? (
        <InlineNotice tone="success" title="CSV 다운로드 시작">
          브라우저 다운로드 목록에서 파일을 확인하세요.
        </InlineNotice>
      ) : null}

      <SectionCard
        title="관리자 변경 이력"
        headingLevel={2}
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
          <div className="data-table-scroll" role="region" aria-label="관리자 변경 이력 표" tabIndex={0}>
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
                    <TableStateCell colSpan={5}>
                      <span role="status">변경 이력을 불러오는 중입니다.</span>
                    </TableStateCell>
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
          </div>
        )}
        <UpdatedAt at={logs.dataUpdatedAt} />
      </SectionCard>

      <SectionCard
        title="최근 인증 이벤트"
        headingLevel={2}
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
          <div className="data-table-scroll" role="region" aria-label="최근 인증 이벤트 표" tabIndex={0}>
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
                    <TableStateCell colSpan={6}>
                      <span role="status">인증 이벤트를 불러오는 중입니다.</span>
                    </TableStateCell>
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
          </div>
        )}
      </SectionCard>
    </div>
  );
}
