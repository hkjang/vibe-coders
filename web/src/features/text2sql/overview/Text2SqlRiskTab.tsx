import { useRef, useState } from "react";

import { PanelFailure } from "@/features/text2sql/overview/text2sql-presentation";
import { clip } from "@/features/text2sql/overview/text2sql-labels";
import { Text2SqlSpanDialog } from "@/features/text2sql/overview/Text2SqlSpanDialog";
import type { Text2SQLAnomalies, Text2SQLRiskEntry } from "@/shared/api/domains/text2sql";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { formatNumber, formatRelative } from "@/shared/utils/format";

type UsageSmell = Text2SQLAnomalies["usage_smells"][number];
type RiskExposure = Text2SQLAnomalies["risk_exposure"][number];

const minRiskOptions = [
  { value: "0", label: "전체" },
  { value: "30", label: "위험 30 이상" },
  { value: "50", label: "위험 50 이상" },
  { value: "70", label: "위험 70 이상" },
];

interface Text2SqlRiskTabProps {
  anomalies: Text2SQLAnomalies | undefined;
  anomaliesError: unknown;
  anomaliesLoading: boolean;
  minRisk: number;
  onMinRiskChange: (value: number) => void;
  onRetryAnomalies: () => void;
  onRetryRiskQueue: () => void;
  queue: readonly Text2SQLRiskEntry[];
  riskQueueError: unknown;
  riskQueueLoading: boolean;
  windowLabel: string;
}

export function Text2SqlRiskTab({
  anomalies,
  anomaliesError,
  anomaliesLoading,
  minRisk,
  onMinRiskChange,
  onRetryAnomalies,
  onRetryRiskQueue,
  queue,
  riskQueueError,
  riskQueueLoading,
  windowLabel,
}: Text2SqlRiskTabProps): React.JSX.Element {
  const [timelineRequestId, setTimelineRequestId] = useState("");
  const triggerRef = useRef<HTMLElement | null>(null);

  const entryColumn = createDataTableColumnHelper<Text2SQLRiskEntry>();
  const queueColumns = entryColumn.columns([
    entryColumn.accessor((row) => row.log.created_at, {
      id: "created_at",
      header: "시각",
      cell: ({ getValue }) => formatRelative(getValue()),
    }),
    entryColumn.accessor((row) => row.log.team, {
      id: "team",
      header: "팀",
      cell: ({ row }) => (
        <div className="t2s-cell-stack">
          <span>{row.original.log.team || "—"}</span>
          <span>{row.original.log.upstream_model}</span>
        </div>
      ),
    }),
    entryColumn.accessor((row) => row.log.schema_name, {
      id: "schema",
      header: "스키마(버전)",
      cell: ({ row }) => (
        <div className="t2s-cell-stack">
          <span>{row.original.log.schema_name || "—"}</span>
          {row.original.log.schema_version > 0 ? <span>v{row.original.log.schema_version}</span> : null}
        </div>
      ),
    }),
    entryColumn.accessor((row) => row.log.question, {
      id: "question",
      header: "질문",
      cell: ({ getValue }) => <span className="truncate">{clip(getValue(), 50) || "—"}</span>,
    }),
    entryColumn.display({
      id: "valid",
      header: "검증",
      cell: ({ row }) =>
        row.original.log.valid ? (
          <Badge tone="success">유효</Badge>
        ) : (
          <Badge tone="danger">{clip(row.original.log.reject_reason || "거부", 40)}</Badge>
        ),
    }),
    entryColumn.accessor((row) => row.log.failure_category, {
      id: "failure",
      header: "실패 분류",
      cell: ({ getValue }) => (getValue() ? <Badge tone="warning">{getValue()}</Badge> : "—"),
    }),
    entryColumn.accessor((row) => row.log.explain_risk, {
      id: "risk",
      header: "EXPLAIN 위험",
      cell: ({ getValue }) =>
        getValue() > 0 ? (
          <Badge tone={getValue() >= 70 ? "danger" : "warning"}>{formatNumber(getValue())}</Badge>
        ) : (
          "—"
        ),
    }),
    entryColumn.display({
      id: "suggestions",
      header: "개선 제안",
      cell: ({ row }) =>
        row.original.suggestions.length === 0 ? (
          "—"
        ) : (
          <ul className="t2s-suggestion-list">
            {row.original.suggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </ul>
        ),
    }),
    entryColumn.display({
      id: "timeline",
      header: "단계",
      cell: ({ row }) => (
        <Button
          size="small"
          variant="ghost"
          disabled={row.original.log.request_id === ""}
          title={row.original.log.request_id === "" ? "request_id가 없는 오래된 기록입니다." : undefined}
          onClick={(event) => {
            triggerRef.current = event.currentTarget;
            setTimelineRequestId(row.original.log.request_id);
          }}
        >
          타임라인
        </Button>
      ),
    }),
  ]) as Array<DataTableColumn<Text2SQLRiskEntry>>;

  const smellColumn = createDataTableColumnHelper<UsageSmell>();
  const smellColumns = smellColumn.columns([
    smellColumn.accessor((row) => row.subject, {
      id: "subject",
      header: "주체 (api_key)",
      cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
    }),
    smellColumn.accessor((row) => row.category, {
      id: "category",
      header: "유형",
      cell: ({ getValue }) => <Badge tone="warning">{getValue()}</Badge>,
    }),
    smellColumn.accessor((row) => row.count, {
      id: "count",
      header: "횟수",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    smellColumn.accessor((row) => row.sample, {
      id: "sample",
      header: "예시",
      cell: ({ getValue }) => <span className="truncate">{clip(getValue(), 50) || "—"}</span>,
    }),
  ]) as Array<DataTableColumn<UsageSmell>>;

  const exposureColumn = createDataTableColumnHelper<RiskExposure>();
  const exposureColumns = exposureColumn.columns([
    exposureColumn.accessor((row) => row.team, { id: "team", header: "팀" }),
    exposureColumn.accessor((row) => row.total, {
      id: "total",
      header: "총 질의",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    exposureColumn.accessor((row) => row.rejected, {
      id: "rejected",
      header: "거부",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    exposureColumn.accessor((row) => row.high_risk, {
      id: "high_risk",
      header: "고위험",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    exposureColumn.accessor((row) => row.probes, {
      id: "probes",
      header: "탐침",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    exposureColumn.accessor((row) => row.risk_score, {
      id: "risk_score",
      header: "위험 점수",
      cell: ({ getValue }) => <strong className="cell-number">{formatNumber(getValue())}</strong>,
    }),
  ]) as Array<DataTableColumn<RiskExposure>>;

  const drifts = anomalies?.intent_drifts ?? [];

  return (
    <div className="t2s-stack">
      <SectionCard
        title={`관리자 위험 요청 큐 (${windowLabel})`}
        description="거부된 요청, 고위험 EXPLAIN, 실패로 분류된 요청과 개선 제안입니다."
      >
        <Toolbar label="위험 요청 필터">
          <label className="t2s-inline-field">
            <span>최소 위험도</span>
            <Select
              value={String(minRisk)}
              options={minRiskOptions}
              onChange={(event) => onMinRiskChange(Number(event.target.value))}
            />
          </label>
        </Toolbar>
        {riskQueueError ? (
          <PanelFailure
            error={riskQueueError}
            hasData={queue.length > 0}
            label="위험 요청 큐"
            onRetry={onRetryRiskQueue}
          />
        ) : null}
        <DataTable
          caption="Text2SQL 위험 요청 큐"
          columns={queueColumns}
          data={queue}
          loading={riskQueueLoading}
          getRowId={(row, index) => row.log.id || `${row.log.request_id}-${index}`}
          emptyMessage="선택 기간에 위험 요청이 없습니다. (거부 · 고위험 EXPLAIN · 실패 분류 대상)"
        />
      </SectionCard>

      <SectionCard
        title={`행동 이상 탐지 (${windowLabel})`}
        description="탐지 전용입니다. 이 화면의 신호만으로 요청을 차단하지 않습니다."
      >
        {anomaliesError ? (
          <PanelFailure
            error={anomaliesError}
            hasData={(anomalies?.usage_smells.length ?? 0) > 0}
            label="행동 이상 탐지"
            onRetry={onRetryAnomalies}
          />
        ) : null}
        <DataTable
          caption="이상 사용 신호"
          columns={smellColumns}
          data={anomalies?.usage_smells ?? []}
          loading={anomaliesLoading}
          getRowId={(row, index) => `${row.subject}-${row.category}-${index}`}
          emptyMessage="이상 사용 신호가 없습니다."
        />
        <DataTable
          caption="팀별 위험 노출"
          columns={exposureColumns}
          data={anomalies?.risk_exposure ?? []}
          loading={anomaliesLoading}
          getRowId={(row) => row.team}
          emptyMessage="팀별 위험 노출 집계가 없습니다."
        />
        {drifts.length > 0 ? (
          <InlineNotice tone="warning" title={`의도 이동 감지 ${drifts.length}건`}>
            <ul>
              {drifts.map((drift) => (
                <li key={`${drift.subject}-${drift.drift_seen}`}>
                  <code className="mono">{drift.subject}</code> — {drift.reason} (
                  {formatRelative(drift.drift_seen)})
                </li>
              ))}
            </ul>
          </InlineNotice>
        ) : null}
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
