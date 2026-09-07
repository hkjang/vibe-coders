import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useCallback, useMemo } from "react";

import { QuerySection, ScopeNotice } from "@/features/security/security-ui";
import { auditLimit } from "@/features/security/overview/security-overview";
import { apiClient } from "@/shared/api/client";
import type { AdminAuditLog, AuditLimitQuery, AuthEvent } from "@/shared/api/domains/security";
import { endpoints } from "@/shared/api/endpoints";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { formatDateTime, formatRelative, shortId } from "@/shared/utils/format";

const limitOptions = ["25", "50", "100", "200"] as const;

function authEventTone(eventType: string): "danger" | "muted" | "success" | "warning" {
  if (eventType.includes("failed") || eventType.includes("denied")) return "danger";
  if (eventType.includes("logout") || eventType.includes("revoke")) return "warning";
  if (eventType.includes("login")) return "success";
  return "muted";
}

function authEventColumns(): ReadonlyArray<DataTableColumn<AuthEvent>> {
  const column = createDataTableColumnHelper<AuthEvent>();
  return column.columns([
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "시각",
      cell: ({ getValue }) => <time title={formatDateTime(getValue())}>{formatRelative(getValue())}</time>,
    }),
    column.accessor((row) => row.event_type, {
      id: "event_type",
      header: "이벤트",
      cell: ({ getValue }) => <Badge tone={authEventTone(getValue())}>{getValue() || "—"}</Badge>,
    }),
    column.accessor((row) => row.actor_user_id, {
      id: "actor",
      header: "행위자",
      cell: ({ getValue }) => <span className="cell-mono">{getValue() || "—"}</span>,
    }),
    column.accessor((row) => row.team_id, { id: "team", header: "팀" }),
    column.accessor((row) => row.ip, { id: "ip", header: "IP" }),
    column.accessor((row) => row.detail, {
      id: "detail",
      header: "상세",
      cell: ({ getValue }) => <span className="truncate">{getValue() || "—"}</span>,
    }),
  ]) as Array<DataTableColumn<AuthEvent>>;
}

function auditLogColumns(): ReadonlyArray<DataTableColumn<AdminAuditLog>> {
  const column = createDataTableColumnHelper<AdminAuditLog>();
  return column.columns([
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "시각",
      cell: ({ getValue }) => <time title={formatDateTime(getValue())}>{formatRelative(getValue())}</time>,
    }),
    column.accessor((row) => row.admin_id, {
      id: "admin",
      header: "관리자",
      cell: ({ getValue }) => <span className="cell-mono">{getValue() || "—"}</span>,
    }),
    column.accessor((row) => row.action, { id: "action", header: "작업" }),
    column.accessor((row) => row.before_value, {
      id: "before",
      header: "이전 값",
      cell: ({ getValue }) => (
        <span className="truncate" title={getValue()}>
          {shortId(getValue(), 40)}
        </span>
      ),
    }),
    column.accessor((row) => row.after_value, {
      id: "after",
      header: "이후 값",
      cell: ({ getValue }) => (
        <span className="truncate" title={getValue()}>
          {shortId(getValue(), 40)}
        </span>
      ),
    }),
  ]) as Array<DataTableColumn<AdminAuditLog>>;
}

interface AuditTabProps {
  canRead: boolean;
  refreshInterval: number | false;
}

export function AuditTab({ canRead, refreshInterval }: AuditTabProps): React.JSX.Element {
  const [params, updateSearch] = useSearchState();
  const limit = auditLimit(params.get("limit"));
  const query: AuditLimitQuery = { limit };

  const authEvents = useQuery({
    queryKey: ["security", "auth-events", limit],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.security.authEvents, {
        query,
        signal,
        routeId: "security.overview",
      }),
    enabled: canRead,
    refetchInterval: refreshInterval,
    refetchIntervalInBackground: false,
  });
  const auditLogs = useQuery({
    queryKey: ["security", "audit-logs", limit],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.security.auditLogs, {
        query,
        signal,
        routeId: "security.overview",
      }),
    enabled: canRead,
    refetchInterval: refreshInterval,
    refetchIntervalInBackground: false,
  });

  const events = useMemo(() => authEvents.data?.events ?? [], [authEvents.data]);
  const logs = auditLogs.data?.audit_logs ?? [];

  const exportCsv = useCallback((): void => {
    downloadCsv(
      "auth-events.csv",
      toCsv(events, [
        { header: "created_at", value: (row) => row.created_at },
        { header: "event_type", value: (row) => row.event_type },
        { header: "actor_user_id", value: (row) => row.actor_user_id },
        { header: "api_key_id", value: (row) => row.api_key_id },
        { header: "team_id", value: (row) => row.team_id },
        { header: "ip", value: (row) => row.ip },
        { header: "user_agent", value: (row) => row.user_agent },
        { header: "detail", value: (row) => row.detail },
      ]),
    );
  }, [events]);

  if (!canRead) return <ScopeNotice scope="admin:read" what="인증 이벤트와 감사 로그" />;

  return (
    <>
      <Toolbar
        label="감사 조회 조건"
        end={
          <Button size="small" onClick={exportCsv} disabled={events.length === 0}>
            <Download aria-hidden="true" /> 인증 이벤트 CSV
          </Button>
        }
      >
        <FormField label="가져올 건수">
          {(control) => (
            <Select
              {...control}
              value={String(limit)}
              onChange={(event) => updateSearch({ limit: event.target.value })}
            >
              {limitOptions.map((value) => (
                <option key={value} value={value}>
                  {value}건
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </Toolbar>

      <QuerySection
        error={authEvents.isError ? authEvents.error : undefined}
        hasData={Boolean(authEvents.data)}
        label="인증 이벤트"
        onRetry={() => void authEvents.refetch()}
        pending={authEvents.isPending}
      >
        <SectionCard title="인증 이벤트" description="로그인, 실패, 권한 거부 기록입니다.">
          <DataTable
            caption="인증 이벤트"
            columns={authEventColumns()}
            data={events}
            emptyMessage="기록된 인증 이벤트가 없습니다."
            getRowId={(row, index) => row.id || `auth-${index}`}
          />
        </SectionCard>
      </QuerySection>

      <QuerySection
        error={auditLogs.isError ? auditLogs.error : undefined}
        hasData={Boolean(auditLogs.data)}
        label="관리자 감사 로그"
        onRetry={() => void auditLogs.refetch()}
        pending={auditLogs.isPending}
      >
        <SectionCard title="관리자 감사 로그" description="관리자가 수행한 변경 이력입니다.">
          <DataTable
            caption="관리자 감사 로그"
            columns={auditLogColumns()}
            data={logs}
            emptyMessage="기록된 변경 이력이 없습니다."
            getRowId={(row, index) => row.id || `audit-${index}`}
          />
        </SectionCard>
      </QuerySection>
    </>
  );
}
