import { PanelFailure } from "@/features/security/redteam/RedTeamParts";
import { decisionTone, scoreTone, riskTone } from "@/features/security/redteam/redteam-ui";
import type { RedTeamData } from "@/features/security/redteam/use-redteam-data";
import type { RedTeamDrift, RedTeamFailingTarget, RedTeamMatrixCell } from "@/shared/api/domains/redteam";
import { Badge } from "@/shared/components/ui/Badge";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { formatNumber, formatRelative } from "@/shared/utils/format";

function matrixColumns(): ReadonlyArray<DataTableColumn<RedTeamMatrixCell>> {
  const column = createDataTableColumnHelper<RedTeamMatrixCell>();
  const counter = (key: "pass" | "warning" | "fail" | "critical", header: string, tone: string) =>
    column.accessor((row) => row[key], {
      id: key,
      header,
      cell: ({ getValue }) =>
        getValue() > 0 && tone !== "muted" ? (
          <Badge tone={decisionTone(key)}>{formatNumber(getValue())}</Badge>
        ) : (
          <span className="cell-number">{formatNumber(getValue())}</span>
        ),
    });
  return column.columns([
    column.accessor((row) => row.target_type, {
      id: "target_type",
      header: "대상 유형",
      cell: ({ getValue }) => <Badge tone="info">{getValue() || "—"}</Badge>,
    }),
    column.accessor((row) => row.pack_category, { id: "pack_category", header: "팩 분류" }),
    counter("pass", "통과", "muted"),
    counter("warning", "경고", "warning"),
    counter("fail", "실패", "danger"),
    counter("critical", "치명", "danger"),
    column.accessor((row) => row.total, {
      id: "total",
      header: "계",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
  ]);
}

function failingColumns(): ReadonlyArray<DataTableColumn<RedTeamFailingTarget>> {
  const column = createDataTableColumnHelper<RedTeamFailingTarget>();
  return column.columns([
    column.accessor((row) => row.target_ref, {
      id: "target",
      header: "대상",
      cell: ({ row }) => (
        <div className="rt-stacked-cell">
          <code className="mono">{row.original.target_ref || row.original.target_id}</code>
          <span>
            {row.original.target_type || "—"} · {row.original.owner_team || "담당 팀 미지정"}
          </span>
        </div>
      ),
    }),
    column.accessor((row) => row.critical, {
      id: "critical",
      header: "치명",
      cell: ({ getValue }) =>
        getValue() > 0 ? <Badge tone="danger">{formatNumber(getValue())}</Badge> : "0",
    }),
    column.accessor((row) => row.fail, {
      id: "fail",
      header: "실패",
      cell: ({ getValue }) =>
        getValue() > 0 ? <Badge tone="danger">{formatNumber(getValue())}</Badge> : "0",
    }),
    column.accessor((row) => row.warning, {
      id: "warning",
      header: "경고",
      cell: ({ getValue }) =>
        getValue() > 0 ? <Badge tone="warning">{formatNumber(getValue())}</Badge> : "0",
    }),
    column.accessor((row) => row.max_risk, {
      id: "max_risk",
      header: "최고 위험",
      cell: ({ getValue }) => <Badge tone={scoreTone(getValue())}>{formatNumber(getValue())}</Badge>,
    }),
  ]);
}

function driftColumns(): ReadonlyArray<DataTableColumn<RedTeamDrift>> {
  const column = createDataTableColumnHelper<RedTeamDrift>();
  return column.columns([
    column.accessor((row) => row.target_id, {
      id: "target_id",
      header: "대상",
      cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
    }),
    column.accessor((row) => row.pack_id, {
      id: "pack_id",
      header: "팩",
      cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
    }),
    column.accessor((row) => row.current_score, {
      id: "score",
      header: "기준 → 현재",
      cell: ({ row }) =>
        `${formatNumber(row.original.baseline_score)} → ${formatNumber(row.original.current_score)}`,
    }),
    column.accessor((row) => row.delta, {
      id: "delta",
      header: "드리프트",
      cell: ({ row }) => (
        <span>
          <Badge tone="danger">+{formatNumber(row.original.delta)}</Badge>{" "}
          <span className="rt-muted">임계 {formatNumber(row.original.threshold)}</span>
        </span>
      ),
    }),
    column.accessor((row) => row.last_passed_at, {
      id: "last_passed_at",
      header: "최근 통과",
      cell: ({ getValue }) => (
        <span title={getValue() || undefined}>{formatRelative(getValue() || null)}</span>
      ),
    }),
  ]);
}

export function RedTeamOverviewTab({ data }: { data: RedTeamData }): React.JSX.Element {
  const { baselines, campaigns, dashboard, probePacks, runs, targets } = data;
  const targetRows = targets.data?.targets ?? [];
  const packRows = probePacks.data?.probe_packs ?? [];
  const campaignRows = campaigns.data?.campaigns ?? [];
  const runRows = runs.data?.runs ?? [];
  const summary = dashboard.data?.summary;
  const byDecision = summary?.by_decision ?? {};
  const highRiskTargets = targetRows.filter((target) =>
    ["high", "critical"].includes(target.risk_level.toLowerCase()),
  ).length;
  const autoCampaigns = campaignRows.filter((campaign) => campaign.trigger_source === "post-change").length;
  const failedRuns = runRows.filter((run) => run.status === "failed").length;
  const maxRunRisk = runRows.reduce((max, run) => Math.max(max, run.risk_score), 0);
  const dash = (value: number | undefined, unavailable: boolean): string =>
    unavailable ? "—" : formatNumber(value ?? 0);

  return (
    <div className="rt-stack">
      <StatGrid label="레드팀 대상 요약">
        <StatCard label="대상" value={dash(targetRows.length, targets.isPending)} />
        <StatCard
          label="고위험/치명 대상"
          tone={highRiskTargets > 0 ? "warning" : "default"}
          value={dash(highRiskTargets, targets.isPending)}
        />
        <StatCard label="프로브 팩" value={dash(packRows.length, probePacks.isPending)} />
        <StatCard label="자동 회귀 점검" value={dash(autoCampaigns, campaigns.isPending)} />
        <StatCard
          label="최근 실행 위험"
          tone={maxRunRisk >= 65 ? "danger" : maxRunRisk >= 25 ? "warning" : "default"}
          value={dash(maxRunRisk, runs.isPending)}
        />
        <StatCard
          label="실패한 실행"
          tone={failedRuns > 0 ? "danger" : "default"}
          value={dash(failedRuns, runs.isPending)}
        />
      </StatGrid>

      <StatGrid label="레드팀 결과 요약">
        <StatCard label="결과 수" value={dash(summary?.total_results, dashboard.isPending)} />
        <StatCard label="치명" tone="danger" value={dash(byDecision.critical, dashboard.isPending)} />
        <StatCard label="실패" tone="danger" value={dash(byDecision.fail, dashboard.isPending)} />
        <StatCard label="경고" tone="warning" value={dash(byDecision.warning, dashboard.isPending)} />
        <StatCard
          label="외부 대상"
          hint="외부 provider egress"
          value={dash(summary?.external_targets, dashboard.isPending)}
        />
        <StatCard
          label="미조치"
          tone={(summary?.open_remediations ?? 0) > 0 ? "warning" : "default"}
          value={dash(summary?.open_remediations, dashboard.isPending)}
        />
      </StatGrid>

      {dashboard.isError ? (
        <PanelFailure
          error={dashboard.error}
          hasData={Boolean(dashboard.data)}
          label="레드팀 대시보드"
          onRetry={() => void dashboard.refetch()}
        />
      ) : null}

      <div className="rt-grid-2">
        <SectionCard
          title="결과 매트릭스 (대상 × 프로브 팩)"
          description="대상 유형과 프로브 팩 분류별 판정 건수입니다. 프롬프트·응답 원문은 포함하지 않습니다."
        >
          <DataTable
            caption="대상 유형과 프로브 팩 분류별 판정 건수"
            columns={matrixColumns()}
            data={dashboard.data?.matrix ?? []}
            emptyMessage="결과 매트릭스 데이터가 없습니다. 캠페인을 실행하면 채워집니다."
            loading={dashboard.isPending}
          />
        </SectionCard>
        <SectionCard title="상위 실패 대상" description="치명·실패·경고가 많은 대상 순위입니다.">
          <DataTable
            caption="치명·실패·경고가 많은 상위 대상"
            columns={failingColumns()}
            data={dashboard.data?.top_failing_targets ?? []}
            emptyMessage="실패한 대상이 없습니다."
            loading={dashboard.isPending}
          />
        </SectionCard>
      </div>

      <SectionCard
        title={`기준선 드리프트 (${formatNumber(dashboard.data?.drift.length ?? 0)})`}
        description="마지막 통과 기준선 대비 위험 점수가 임계 이상 상승한 대상입니다."
        actions={
          <span className="rt-muted">
            기준선 앵커 {formatNumber(baselines.data?.baselines.length ?? 0)}건
          </span>
        }
      >
        <DataTable
          caption="기준선 대비 위험 점수가 상승한 대상"
          columns={driftColumns()}
          data={dashboard.data?.drift ?? []}
          emptyMessage="기준선 드리프트가 없습니다."
          loading={dashboard.isPending}
        />
      </SectionCard>

      {dashboard.data?.note ? <p className="rt-note">{dashboard.data.note}</p> : null}
      <p className="rt-muted">
        위험도 표기: {""}
        <Badge tone={riskTone("critical")}>critical</Badge> <Badge tone={riskTone("high")}>high</Badge>{" "}
        <Badge tone={riskTone("medium")}>medium</Badge> <Badge tone={riskTone("low")}>low</Badge>
      </p>
    </div>
  );
}
