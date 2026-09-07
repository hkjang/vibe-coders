import { DatabaseZap, PlugZap, RefreshCcwDot, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";

import { DataQueryNotice } from "@/features/data/DataQueryNotice";
import { SimpleTable } from "@/features/data/SimpleTable";
import { ClickhouseTestDialog } from "@/features/data/warehouse/ClickhouseTestDialog";
import { dataQueryKeys, usePipelineQueries } from "@/features/data/warehouse/use-warehouse-queries";
import { apiClient } from "@/shared/api/client";
import type {
  ClickhouseLagTable,
  DwConsistencyRow,
  DwSinkRetry,
  DwSinkState,
} from "@/shared/api/domains/data.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const pipeline = endpoints.domains.data.pipeline;
const consistencyDayOptions = [7, 30, 90];
const sinkDays = 7;
const eventLimit = 20;

type PipelineAction = "bootstrap" | "sink" | "retry";

interface PipelineTabProps {
  canWrite: boolean;
  days: number;
  eventTable: string;
  onFilterChange: (updates: Record<string, string | undefined>) => void;
}

const writeDeniedReason = "admin:write 권한이 필요합니다.";

export function PipelineTab({
  canWrite,
  days,
  eventTable,
  onFilterChange,
}: PipelineTabProps): React.JSX.Element {
  const { overview, lag, sinkStatus, consistency } = usePipelineQueries(days);
  const [action, setAction] = useState<PipelineAction | undefined>();
  const [testOpen, setTestOpen] = useState(false);
  const [events, setEvents] = useState<unknown>();
  const [eventsError, setEventsError] = useState<string | undefined>();
  const actionTriggerRef = useRef<HTMLButtonElement>(null);
  const testTriggerRef = useRef<HTMLButtonElement>(null);

  const bootstrap = useMutationFeedback({
    mutate: () => apiClient.request(pipeline.bootstrap),
    invalidates: [dataQueryKeys.pipeline],
    successMessage: (result) =>
      result.ok ? "ClickHouse 스키마를 생성했습니다." : "일부 객체 생성에 실패했습니다.",
    errorMessage: "스키마를 생성하지 못했습니다.",
  });
  const runSink = useMutationFeedback({
    mutate: () => apiClient.request(pipeline.runSink, { query: { days: sinkDays } }),
    invalidates: [dataQueryKeys.pipeline, dataQueryKeys.warehouse],
    successMessage: (result) => `${formatNumber(result.sent_rows)}행을 적재했습니다.`,
    errorMessage: "적재하지 못했습니다.",
  });
  const retry = useMutationFeedback({
    mutate: () => apiClient.request(pipeline.sinkRetry),
    invalidates: [dataQueryKeys.pipeline, dataQueryKeys.warehouse],
    successMessage: (result) =>
      `${formatNumber(result.recovered_dimensions)}개 차원, ${formatNumber(result.sent_rows)}행을 재처리했습니다.`,
    errorMessage: "재처리하지 못했습니다.",
  });

  const loadEvents = (table: string): void => {
    setEventsError(undefined);
    setEvents(undefined);
    onFilterChange({ table: table || undefined });
    if (!table) return;
    void apiClient
      .request(pipeline.events, { query: { table, limit: eventLimit } })
      .then((result) => setEvents(result.data.length > 0 ? result.data : (result.raw ?? [])))
      .catch(() => setEventsError("최근 적재 내역을 불러오지 못했습니다."));
  };

  const status = overview.data;
  const ping = status?.ping;
  const configured = status?.configured === true;
  const actionCopy: Record<PipelineAction, { title: string; description: string; label: string }> = {
    bootstrap: {
      title: "ClickHouse 스키마 생성",
      description: "설정된 데이터베이스와 팩트 테이블을 IF NOT EXISTS로 생성합니다.",
      label: "생성",
    },
    sink: {
      title: "지금 적재",
      description: `최근 ${sinkDays}일 롤업을 다시 계산해 ClickHouse로 전송합니다.`,
      label: "적재",
    },
    retry: {
      title: "실패분 재처리",
      description: "재처리 대기열에 남아 있는 차원을 다시 전송합니다.",
      label: "재처리",
    },
  };
  const runAction = async (): Promise<void> => {
    if (action === "bootstrap") await bootstrap.mutateAsync(undefined);
    if (action === "sink") await runSink.mutateAsync(undefined);
    if (action === "retry") await retry.mutateAsync(undefined);
  };

  return (
    <div className="data-section-stack">
      <Toolbar
        label="데이터 파이프라인 작업"
        end={
          <div className="data-inline-actions">
            <Button
              ref={testTriggerRef}
              variant="secondary"
              disabled={!canWrite}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={() => setTestOpen(true)}
            >
              <PlugZap aria-hidden="true" /> 연결 테스트
            </Button>
            <Button
              ref={actionTriggerRef}
              variant="secondary"
              disabled={!canWrite}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={() => setAction("bootstrap")}
            >
              <DatabaseZap aria-hidden="true" /> 스키마 생성
            </Button>
            <Button
              variant="secondary"
              disabled={!canWrite}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={() => setAction("sink")}
            >
              <RefreshCcwDot aria-hidden="true" /> 지금 적재
            </Button>
            <Button
              variant="secondary"
              disabled={!canWrite}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={() => setAction("retry")}
            >
              <ShieldCheck aria-hidden="true" /> 실패분 재처리
            </Button>
          </div>
        }
      >
        <label className="data-filter" htmlFor="dw-consistency-days">
          <span>정합성 비교 기간</span>
          <Select
            id="dw-consistency-days"
            value={String(days)}
            onChange={(event) => onFilterChange({ days: event.target.value })}
            options={consistencyDayOptions.map((item) => ({
              value: String(item),
              label: `최근 ${item}일`,
            }))}
          />
        </label>
        <label className="data-filter" htmlFor="dw-event-table">
          <span>최근 적재 내역</span>
          <Select
            id="dw-event-table"
            value={eventTable}
            onChange={(event) => loadEvents(event.target.value)}
            placeholder="테이블 선택"
          >
            {(lag.data?.tables ?? []).map((table) => (
              <option key={table.table} value={table.table}>
                {table.table}
              </option>
            ))}
          </Select>
        </label>
      </Toolbar>

      {!canWrite ? (
        <InlineNotice tone="info" title="읽기 전용으로 열려 있습니다.">
          적재, 스키마 생성, 재처리는 {writeDeniedReason}
        </InlineNotice>
      ) : null}

      {overview.isError ? (
        <DataQueryNotice
          error={overview.error}
          hasPreviousData={Boolean(status)}
          label="ClickHouse 상태"
          onRetry={() => void overview.refetch()}
        />
      ) : null}

      <SectionCard
        title="연결 상태"
        description="ClickHouse 접속과 롤업 테이블 구성"
        actions={
          ping ? <Badge tone={ping.ok ? "success" : "danger"}>{ping.ok ? "정상" : "연결 실패"}</Badge> : null
        }
      >
        {!configured && status ? (
          <InlineNotice tone="warning" title="ClickHouse가 설정되어 있지 않습니다.">
            설정 화면에서 clickhouse.url과 clickhouse.table을 채운 뒤 연결을 테스트하세요.
          </InlineNotice>
        ) : null}
        <KeyValueList
          items={[
            { label: "데이터베이스", value: status?.database, mono: true },
            { label: "롤업 테이블", value: status?.table, mono: true },
            { label: "응답 시간", value: ping?.ok ? `${formatNumber(ping.latency_ms)}ms` : undefined },
            { label: "연결 메시지", value: ping?.ok ? undefined : ping?.message },
            { label: "자동 적재", value: status?.sink.auto_enabled ? "사용" : "미사용" },
            { label: "적재 주기", value: status?.sink.interval },
            { label: "적재 일수", value: status ? formatNumber(status.sink.days) : undefined },
            { label: "테이블 엔진", value: status?.rollup_table?.engine, mono: true },
            {
              label: "중복 제거 정렬키",
              value: status?.rollup_table
                ? status.rollup_table.dedupe_ok
                  ? "정상"
                  : "확인 필요"
                : undefined,
            },
          ]}
        />
      </SectionCard>

      <SectionCard title="요청 팩트 큐" description="비동기 적재 큐와 재시도 배치">
        <StatGrid label="요청 팩트 큐 지표">
          <StatCard label="큐 적재량" value={formatNumber(status?.request_fact.queue_depth)} />
          <StatCard label="큐 용량" value={formatNumber(status?.request_fact.queue_cap)} />
          <StatCard
            label="유실"
            tone={status && status.request_fact.dropped > 0 ? "danger" : "default"}
            value={formatNumber(status?.request_fact.dropped)}
          />
          <StatCard
            label="재시도 배치"
            tone={status && status.request_fact.retry_batches > 0 ? "warning" : "default"}
            value={formatNumber(status?.request_fact.retry_batches)}
          />
          <StatCard label="배치 크기" value={formatNumber(status?.request_fact.batch_size)} />
          <StatCard label="플러시 주기" value={status?.request_fact.flush || "—"} />
        </StatGrid>
      </SectionCard>

      <SectionCard title="적재 워터마크" description="차원별 마지막 성공 지점">
        {sinkStatus.isError ? (
          <DataQueryNotice
            error={sinkStatus.error}
            hasPreviousData={Boolean(sinkStatus.data)}
            label="적재 상태"
            onRetry={() => void sinkStatus.refetch()}
          />
        ) : null}
        <SimpleTable<DwSinkState>
          caption="차원별 적재 워터마크"
          loading={sinkStatus.isPending}
          rows={sinkStatus.data?.state ?? []}
          emptyMessage="아직 적재된 차원이 없습니다. ‘지금 적재’를 실행하면 채워집니다."
          columns={[
            { id: "dimension", header: "차원", cell: (row) => row.dimension },
            { id: "day", header: "마지막 동기화 일자", cell: (row) => row.last_synced_day || "—" },
            {
              id: "rows",
              header: "전송 행",
              cell: (row) => <span className="cell-number">{formatNumber(row.rows_sent)}</span>,
            },
            { id: "at", header: "마지막 성공", cell: (row) => formatDateTime(row.last_success_at) },
          ]}
        />
      </SectionCard>

      <SectionCard title="재처리 대기열" description="전송에 실패해 재시도를 기다리는 차원">
        <SimpleTable<DwSinkRetry>
          caption="재처리 대기 중인 차원"
          loading={sinkStatus.isPending}
          rows={sinkStatus.data?.retries ?? []}
          emptyMessage="대기 중인 실패 항목이 없습니다."
          columns={[
            { id: "dimension", header: "차원", cell: (row) => row.dimension },
            { id: "since", header: "시작 일자", cell: (row) => row.since_day || "—" },
            {
              id: "attempts",
              header: "시도",
              cell: (row) => <span className="cell-number">{formatNumber(row.attempts)}</span>,
            },
            { id: "error", header: "오류", cell: (row) => <span className="truncate">{row.error}</span> },
            { id: "last", header: "마지막 시도", cell: (row) => formatDateTime(row.last_attempt_at) },
          ]}
        />
      </SectionCard>

      <SectionCard title="Fact 테이블 적재 현황" description="ClickHouse 행 수와 로컬 요청 수 격차">
        {lag.isError ? (
          <DataQueryNotice
            error={lag.error}
            hasPreviousData={Boolean(lag.data)}
            label="적재 격차"
            onRetry={() => void lag.refetch()}
          />
        ) : null}
        <SimpleTable<ClickhouseLagTable>
          caption="팩트 테이블별 행 수"
          loading={lag.isPending}
          rows={lag.data?.tables ?? []}
          emptyMessage="설정된 팩트 테이블이 없습니다."
          columns={[
            { id: "key", header: "구분", cell: (row) => row.key },
            { id: "table", header: "테이블", cell: (row) => <span className="mono">{row.table}</span> },
            {
              id: "exists",
              header: "존재",
              cell: (row) => (
                <Badge tone={row.exists ? "success" : "warning"}>{row.exists ? "있음" : "없음"}</Badge>
              ),
            },
            {
              id: "rows",
              header: "행 수",
              cell: (row) => <span className="cell-number">{formatNumber(row.rows)}</span>,
            },
          ]}
        />
        {eventsError ? (
          <InlineNotice tone="warning" title="최근 적재 내역">
            {eventsError}
          </InlineNotice>
        ) : null}
        {events !== undefined ? <JsonBlock label={`${eventTable} 최근 행`} value={events} /> : null}
      </SectionCard>

      <SectionCard title="정합성 점검" description="로컬 롤업 원장과 ClickHouse 집계 비교">
        {consistency.isError ? (
          <DataQueryNotice
            error={consistency.error}
            hasPreviousData={Boolean(consistency.data)}
            label="정합성"
            onRetry={() => void consistency.refetch()}
          />
        ) : null}
        {consistency.data ? (
          <InlineNotice
            tone={consistency.data.consistent ? "success" : "warning"}
            title={consistency.data.consistent ? "모든 차원이 일치합니다." : "차이가 있는 차원이 있습니다."}
          >
            비교 시작일 {consistency.data.since || "—"}
          </InlineNotice>
        ) : null}
        <SimpleTable<DwConsistencyRow>
          caption="차원별 정합성 비교"
          loading={consistency.isPending}
          rows={consistency.data?.dimensions ?? []}
          emptyMessage="비교할 차원이 없습니다."
          columns={[
            { id: "dimension", header: "차원", cell: (row) => row.dimension },
            {
              id: "state",
              header: "상태",
              cell: (row) => (
                <Badge tone={row.consistent ? "success" : "warning"}>
                  {row.consistent ? "일치" : "불일치"}
                </Badge>
              ),
            },
            {
              id: "local",
              header: "로컬 요청",
              cell: (row) => <span className="cell-number">{formatNumber(row.postgres.requests)}</span>,
            },
            {
              id: "ch",
              header: "ClickHouse 요청",
              cell: (row) => <span className="cell-number">{formatNumber(row.clickhouse.requests)}</span>,
            },
            {
              id: "diff",
              header: "요청 차이",
              cell: (row) => <span className="cell-number">{formatNumber(row.diff.requests)}</span>,
            },
          ]}
        />
      </SectionCard>

      <ConfirmDialog
        open={action !== undefined}
        onOpenChange={(open) => {
          if (!open) setAction(undefined);
        }}
        returnFocusRef={actionTriggerRef}
        title={action ? actionCopy[action].title : ""}
        description={action ? actionCopy[action].description : ""}
        confirmLabel={action ? actionCopy[action].label : "확인"}
        onConfirm={runAction}
      />

      <ClickhouseTestDialog open={testOpen} onOpenChange={setTestOpen} returnFocusRef={testTriggerRef} />
    </div>
  );
}
