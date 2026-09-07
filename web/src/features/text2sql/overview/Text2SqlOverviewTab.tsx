import { useMemo, useRef, useState } from "react";

import { StatusBadge } from "@/features/text2sql/overview/text2sql-presentation";
import { clip } from "@/features/text2sql/overview/text2sql-labels";
import { Text2SqlSpanDialog } from "@/features/text2sql/overview/Text2SqlSpanDialog";
import type { Text2SQLOverview, Text2SQLQueryLog } from "@/shared/api/domains/text2sql";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { formatKRW, formatNumber, formatPercent, formatRelative } from "@/shared/utils/format";

type ModelMetric = Text2SQLOverview["model_metrics"][number];
type StageMetric = Text2SQLOverview["stage_metrics"][number];
type FailureBucket = Text2SQLOverview["failures"][number];
type RuntimeProfile = Text2SQLOverview["profiles"][number];

interface Text2SqlOverviewTabProps {
  loading: boolean;
  overview: Text2SQLOverview | undefined;
  windowLabel: string;
}

function useLogColumns(
  onOpenTimeline: (log: Text2SQLQueryLog, trigger: HTMLElement) => void,
): ReadonlyArray<DataTableColumn<Text2SQLQueryLog>> {
  return useMemo(() => {
    const column = createDataTableColumnHelper<Text2SQLQueryLog>();
    return column.columns([
      column.accessor((row) => row.created_at, {
        id: "created_at",
        header: "시각",
        cell: ({ getValue }) => formatRelative(getValue()),
      }),
      column.accessor((row) => row.virtual_model, {
        id: "model",
        header: "모델",
        cell: ({ row }) => (
          <div className="t2s-cell-stack">
            <code className="mono">{row.original.virtual_model || "-"}</code>
            <span>→ {row.original.upstream_model || "-"}</span>
          </div>
        ),
      }),
      column.accessor((row) => row.mode, { id: "mode", header: "모드" }),
      column.accessor((row) => row.question, {
        id: "question",
        header: "질문",
        cell: ({ getValue }) => <span className="truncate">{clip(getValue(), 60) || "—"}</span>,
      }),
      column.accessor((row) => row.valid, {
        id: "valid",
        header: "검증",
        cell: ({ row }) => (
          <div className="t2s-cell-stack">
            {row.original.valid ? (
              <Badge tone="success">유효</Badge>
            ) : (
              <Badge tone="danger">{clip(row.original.reject_reason || "거부", 40)}</Badge>
            )}
            {row.original.executed ? <span>실행 {formatNumber(row.original.row_count)}행</span> : null}
          </div>
        ),
      }),
      column.accessor((row) => row.generated_sql, {
        id: "sql",
        header: "생성 SQL",
        cell: ({ getValue }) => <code className="mono truncate">{clip(getValue(), 80) || "—"}</code>,
      }),
      column.accessor((row) => row.cost_krw, {
        id: "cost",
        header: "비용",
        cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
      }),
      column.display({
        id: "timeline",
        header: "단계",
        cell: ({ row }) => (
          <Button
            size="small"
            variant="ghost"
            disabled={row.original.request_id === ""}
            title={row.original.request_id === "" ? "request_id가 없는 오래된 기록입니다." : undefined}
            onClick={(event) => onOpenTimeline(row.original, event.currentTarget)}
          >
            타임라인
          </Button>
        ),
      }),
    ]) as Array<DataTableColumn<Text2SQLQueryLog>>;
  }, [onOpenTimeline]);
}

function modelColumns(): ReadonlyArray<DataTableColumn<ModelMetric>> {
  const column = createDataTableColumnHelper<ModelMetric>();
  return column.columns([
    column.accessor((row) => row.upstream_model, { id: "model", header: "업스트림 모델" }),
    column.accessor((row) => row.total, {
      id: "total",
      header: "질의",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.valid_rate, {
      id: "valid_rate",
      header: "유효율",
      cell: ({ getValue }) => <span className="cell-number">{formatPercent(getValue(), 0)}</span>,
    }),
    column.accessor((row) => row.executed, {
      id: "executed",
      header: "실행",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.errors, {
      id: "errors",
      header: "오류",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.avg_cost_krw, {
      id: "avg_cost",
      header: "평균 비용",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
    column.accessor((row) => row.avg_latency_ms, {
      id: "avg_latency",
      header: "평균 지연",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())} ms</span>,
    }),
  ]) as Array<DataTableColumn<ModelMetric>>;
}

function stageColumns(totalCost: number): ReadonlyArray<DataTableColumn<StageMetric>> {
  const column = createDataTableColumnHelper<StageMetric>();
  return column.columns([
    column.accessor((row) => row.stage, { id: "stage", header: "단계" }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ getValue }) => <StatusBadge value={getValue()} />,
    }),
    column.accessor((row) => row.model, {
      id: "model",
      header: "모델",
      cell: ({ getValue }) => getValue() || "—",
    }),
    column.accessor((row) => row.count, {
      id: "count",
      header: "횟수",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.error_rate, {
      id: "error_rate",
      header: "오류율",
      cell: ({ getValue }) => <span className="cell-number">{formatPercent(getValue())}</span>,
    }),
    column.accessor((row) => row.avg_latency_ms, {
      id: "avg_latency",
      header: "평균 지연",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())} ms</span>,
    }),
    column.accessor((row) => row.max_latency_ms, {
      id: "max_latency",
      header: "최대 지연",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())} ms</span>,
    }),
    column.accessor((row) => row.total_cost_krw, {
      id: "total_cost",
      header: "총 비용",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
    column.accessor((row) => row.total_cost_krw, {
      id: "cost_share",
      header: "비용 비중",
      cell: ({ getValue }) => (
        <span className="cell-number">{formatPercent(totalCost > 0 ? getValue() / totalCost : 0)}</span>
      ),
    }),
  ]) as Array<DataTableColumn<StageMetric>>;
}

export function Text2SqlOverviewTab({
  loading,
  overview,
  windowLabel,
}: Text2SqlOverviewTabProps): React.JSX.Element {
  const [timelineRequestId, setTimelineRequestId] = useState("");
  const triggerRef = useRef<HTMLElement | null>(null);
  const openTimeline = useMemo(
    () =>
      (log: Text2SQLQueryLog, trigger: HTMLElement): void => {
        triggerRef.current = trigger;
        setTimelineRequestId(log.request_id);
      },
    [],
  );
  const logColumns = useLogColumns(openTimeline);
  const stats = overview?.stats;
  const stageMetrics = overview?.stage_metrics ?? [];
  const totalStageCost = stageMetrics.reduce((sum, metric) => sum + metric.total_cost_krw, 0);
  const unavailable = loading && !overview;

  const profileColumns = useMemo(() => {
    const column = createDataTableColumnHelper<RuntimeProfile>();
    return column.columns([
      column.accessor((row) => row.model, {
        id: "model",
        header: "가상 모델",
        cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
      }),
      column.accessor((row) => row.mode, { id: "mode", header: "모드" }),
      column.accessor((row) => row.upstream, { id: "upstream", header: "업스트림 모델" }),
    ]) as Array<DataTableColumn<RuntimeProfile>>;
  }, []);
  const metricColumns = useMemo(() => modelColumns(), []);
  const stageColumnDefs = useMemo(() => stageColumns(totalStageCost), [totalStageCost]);
  const failureColumns = useMemo(() => {
    const column = createDataTableColumnHelper<FailureBucket>();
    return column.columns([
      column.accessor((row) => row.category, { id: "category", header: "실패 분류" }),
      column.accessor((row) => row.count, {
        id: "count",
        header: "건수",
        cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
      }),
    ]) as Array<DataTableColumn<FailureBucket>>;
  }, []);

  return (
    <div className="t2s-stack">
      <StatGrid label={`Text2SQL 요약 (${windowLabel})`}>
        <StatCard
          label="상태"
          tone={overview?.enabled ? "success" : "danger"}
          value={unavailable ? "—" : overview?.enabled ? "활성" : "비활성"}
          hint="TEXT2SQL_ENABLED 설정"
        />
        <StatCard label={`질의 수 (${windowLabel})`} value={unavailable ? "—" : formatNumber(stats?.total)} />
        <StatCard
          label="유효 SQL"
          value={unavailable ? "—" : formatNumber(stats?.valid)}
          hint={unavailable ? undefined : formatPercent(stats?.valid_rate ?? 0, 0)}
        />
        <StatCard label="실행" value={unavailable ? "—" : formatNumber(stats?.executed)} />
        <StatCard
          label="오류"
          tone={(stats?.errors ?? 0) > 0 ? "warning" : "default"}
          value={unavailable ? "—" : formatNumber(stats?.errors)}
        />
        <StatCard label={`비용 (${windowLabel})`} value={unavailable ? "—" : formatKRW(stats?.cost_krw)} />
      </StatGrid>

      <SectionCard
        title="가상 모델 프로필 (기본)"
        description="환경 설정으로 제공되는 기본 vibe/text2sql-* 가상 모델입니다."
      >
        <DataTable
          caption="기본 가상 모델 프로필"
          columns={profileColumns}
          data={overview?.profiles ?? []}
          loading={unavailable}
          emptyMessage="등록된 기본 프로필이 없습니다."
        />
      </SectionCard>

      <SectionCard title={`모델별 SQL 품질 (${windowLabel})`}>
        <DataTable
          caption="모델별 SQL 품질"
          columns={metricColumns}
          data={overview?.model_metrics ?? []}
          loading={unavailable}
          emptyMessage="모델별 메트릭이 없습니다."
        />
      </SectionCard>

      <SectionCard
        title={`단계별 비용·지연 분석 (${windowLabel})`}
        description="생성·검증·실행·요약 단계별로 비용과 지연을 비교합니다."
      >
        <DataTable
          caption="단계별 비용과 지연"
          columns={stageColumnDefs}
          data={stageMetrics}
          loading={unavailable}
          emptyMessage="단계별 span 메트릭이 없습니다. 신규 Text2SQL 요청부터 수집됩니다."
        />
      </SectionCard>

      <SectionCard title={`실패 원인 분류 (${windowLabel})`}>
        <DataTable
          caption="실패 원인 분류"
          columns={failureColumns}
          data={overview?.failures ?? []}
          loading={unavailable}
          emptyMessage="선택 기간에 실패가 없습니다."
        />
      </SectionCard>

      <SectionCard
        title="최근 Text2SQL 질의"
        description="질문과 생성 SQL은 이 화면에서만 표시하며 URL이나 브라우저 저장소에 남기지 않습니다."
      >
        <DataTable
          caption="최근 Text2SQL 질의"
          columns={logColumns}
          data={overview?.logs ?? []}
          loading={unavailable}
          getRowId={(row, index) => row.id || `${row.request_id}-${index}`}
          emptyMessage="Text2SQL 질의 기록이 없습니다. 사용자가 vibe/text2sql-preview 모델을 호출하면 집계됩니다."
        />
      </SectionCard>

      <Text2SqlSpanDialog
        requestId={timelineRequestId}
        returnFocusRef={triggerRef}
        onOpenChange={(open) => {
          if (!open) setTimelineRequestId("");
        }}
      />
    </div>
  );
}
