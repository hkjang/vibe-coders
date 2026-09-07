import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ClipboardCheck, KeyRound, ShieldAlert, ShieldX, Wrench } from "lucide-react";

import { QuerySection, ScopeNotice } from "@/features/security/security-ui";
import { decisionTone, riskTone } from "@/features/security/overview/security-overview";
import { apiClient } from "@/shared/api/client";
import type {
  SecurityApproval,
  SecurityDashboardQuery,
  SecurityPolicyViolation,
  SecurityRiskyTool,
  SecurityWindow,
} from "@/shared/api/domains/security";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { formatDateTime, formatNumber, formatRelative } from "@/shared/utils/format";

function violationColumns(): ReadonlyArray<DataTableColumn<SecurityPolicyViolation>> {
  const column = createDataTableColumnHelper<SecurityPolicyViolation>();
  return column.columns([
    column.accessor((row) => row.decision, {
      id: "decision",
      header: "결정",
      cell: ({ getValue }) => <Badge tone={decisionTone(getValue())}>{getValue() || "—"}</Badge>,
    }),
    column.accessor((row) => row.reason, {
      id: "reason",
      header: "사유",
      cell: ({ getValue }) => <span className="truncate">{getValue() || "—"}</span>,
    }),
    column.accessor((row) => row.rule, { id: "rule", header: "규칙" }),
    column.accessor((row) => row.endpoint, { id: "endpoint", header: "엔드포인트" }),
    column.accessor((row) => row.risk_score, {
      id: "risk",
      header: "위험",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "시각",
      cell: ({ getValue }) => <time title={formatDateTime(getValue())}>{formatRelative(getValue())}</time>,
    }),
  ]) as Array<DataTableColumn<SecurityPolicyViolation>>;
}

function riskyToolColumns(): ReadonlyArray<DataTableColumn<SecurityRiskyTool>> {
  const column = createDataTableColumnHelper<SecurityRiskyTool>();
  return column.columns([
    column.accessor((row) => row.server_label, { id: "server", header: "서버" }),
    column.accessor((row) => row.tool_name, { id: "tool", header: "도구" }),
    column.accessor((row) => row.risk_level, {
      id: "risk",
      header: "위험도",
      cell: ({ getValue }) => <Badge tone={riskTone(getValue())}>{getValue() || "—"}</Badge>,
    }),
    column.accessor((row) => row.action, { id: "action", header: "조치" }),
  ]) as Array<DataTableColumn<SecurityRiskyTool>>;
}

function approvalColumns(): ReadonlyArray<DataTableColumn<SecurityApproval>> {
  const column = createDataTableColumnHelper<SecurityApproval>();
  return column.columns([
    column.accessor((row) => `${row.subject_type} ${row.subject_id}`.trim(), {
      id: "subject",
      header: "대상",
      cell: ({ getValue }) => <span className="cell-mono">{getValue() || "—"}</span>,
    }),
    column.accessor((row) => row.reason, {
      id: "reason",
      header: "사유",
      cell: ({ getValue }) => <span className="truncate">{getValue() || "—"}</span>,
    }),
    column.accessor((row) => row.risk_score, {
      id: "risk",
      header: "위험",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "요청 시각",
      cell: ({ getValue }) => <time title={formatDateTime(getValue())}>{formatRelative(getValue())}</time>,
    }),
  ]) as Array<DataTableColumn<SecurityApproval>>;
}

interface SecurityDashboardTabProps {
  canRead: boolean;
  range: SecurityWindow;
  refreshInterval: number | false;
}

export function SecurityDashboardTab({
  canRead,
  range,
  refreshInterval,
}: SecurityDashboardTabProps): React.JSX.Element {
  const query: SecurityDashboardQuery = { window: range };
  const dashboard = useQuery({
    queryKey: ["security", "dashboard", range],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.security.dashboard, {
        query,
        signal,
        routeId: "security.overview",
      }),
    enabled: canRead,
    refetchInterval: refreshInterval,
    refetchIntervalInBackground: false,
  });

  if (!canRead) return <ScopeNotice scope="security:read" what="보안 대시보드" />;

  const data = dashboard.data;
  const policy = data?.policy;
  const secrets = data?.secrets;
  const mcp = data?.mcp_summary;
  const byType = Object.entries(secrets?.by_type ?? {});

  return (
    <QuerySection
      error={dashboard.isError ? dashboard.error : undefined}
      hasData={Boolean(data)}
      label="보안 대시보드"
      onRetry={() => void dashboard.refetch()}
      pending={dashboard.isPending}
    >
      <StatGrid label="보안 핵심 지표">
        <StatCard
          icon={<ShieldX aria-hidden="true" />}
          label="차단(정책)"
          tone="danger"
          value={formatNumber(policy?.blocked ?? 0)}
        />
        <StatCard
          icon={<ShieldAlert aria-hidden="true" />}
          label="경고(정책)"
          tone="warning"
          value={formatNumber(policy?.warned ?? 0)}
        />
        <StatCard
          icon={<KeyRound aria-hidden="true" />}
          label="Secret 탐지"
          tone="warning"
          value={formatNumber(secrets?.total ?? 0)}
        />
        <StatCard
          icon={<ClipboardCheck aria-hidden="true" />}
          label="승인 대기"
          value={formatNumber(data?.pending_count ?? 0)}
        />
        <StatCard
          icon={<Wrench aria-hidden="true" />}
          label="위험 도구"
          value={formatNumber(data?.risky_tools.length ?? 0)}
        />
        <StatCard
          icon={<AlertTriangle aria-hidden="true" />}
          label="MCP 오류"
          value={formatNumber(mcp?.total_errors ?? 0)}
          hint={`MCP 호출 ${formatNumber(mcp?.total_calls ?? 0)}건`}
        />
      </StatGrid>

      <SectionCard title="최근 정책 위반" description="조회 구간에서 허용되지 않은 최근 결정입니다.">
        <DataTable
          caption="최근 정책 위반"
          columns={violationColumns()}
          data={policy?.recent ?? []}
          emptyMessage="최근 위반이 없습니다."
          getRowId={(row, index) => `${row.created_at}-${index}`}
        />
      </SectionCard>

      <SectionCard title="Secret Firewall" description="탐지된 비밀정보 유형별 건수입니다.">
        {byType.length === 0 ? (
          <EmptyState
            title="탐지된 Secret이 없습니다."
            description="게이트웨이가 프롬프트에서 비밀정보를 탐지하면 유형별로 집계됩니다."
          />
        ) : (
          <dl className="kv-list">
            {byType.map(([type, value]) => (
              <div key={type} className="kv-item">
                <dt>{type}</dt>
                <dd>{formatNumber(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </SectionCard>

      <SectionCard title="위험 MCP/도구" description="high 또는 critical 위험도로 분류된 도구입니다.">
        <DataTable
          caption="위험 MCP 도구"
          columns={riskyToolColumns()}
          data={data?.risky_tools ?? []}
          emptyMessage="high/critical 도구가 없습니다."
          getRowId={(row, index) => row.id || `tool-${index}`}
        />
      </SectionCard>

      <SectionCard title="승인 대기 큐" description="사람이 결정해야 하는 요청입니다.">
        <DataTable
          caption="승인 대기 큐"
          columns={approvalColumns()}
          data={data?.pending_approvals ?? []}
          emptyMessage="대기 중인 승인이 없습니다."
          getRowId={(row, index) => row.id || `approval-${index}`}
        />
      </SectionCard>
    </QuerySection>
  );
}
