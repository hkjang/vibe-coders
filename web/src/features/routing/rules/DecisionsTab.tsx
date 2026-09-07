import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { routingDecisionsQueryKey } from "@/features/routing/rules/routing-shared";
import { QueryFailureNotice } from "@/features/routing/rules/routing-ui";
import { apiClient } from "@/shared/api/client";
import { type RoutingDecisionEntry } from "@/shared/api/domains/routing";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatNumber, shortId } from "@/shared/utils/format";

const limits = [25, 50, 100, 200] as const;
const defaultLimit = 50;

function limitFrom(value: string | null): number {
  const parsed = Number(value);
  return (limits as readonly number[]).includes(parsed) ? parsed : defaultLimit;
}

function decisionColumns(
  onOpen: (decision: RoutingDecisionEntry, trigger: HTMLButtonElement) => void,
): ReadonlyArray<DataTableColumn<RoutingDecisionEntry>> {
  const column = createDataTableColumnHelper<RoutingDecisionEntry>();
  return column.columns([
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "시각",
      cell: ({ getValue }) => formatDateTime(getValue()),
    }),
    column.accessor((row) => row.requested_model, {
      id: "requested_model",
      header: "요청 모델",
      cell: ({ getValue }) => <span className="mono">{getValue() || "—"}</span>,
    }),
    column.accessor((row) => row.selected_model, {
      id: "selected_model",
      header: "선택 모델",
      cell: ({ row, getValue }) => (
        <span className="mono">
          {getValue() || "—"}
          {row.original.requested_model && row.original.requested_model !== getValue() ? (
            <Badge tone="warning">재작성</Badge>
          ) : null}
        </span>
      ),
    }),
    column.accessor((row) => row.selected_provider, {
      id: "selected_provider",
      header: "공급자",
      cell: ({ getValue }) => getValue() || "—",
    }),
    column.accessor((row) => row.complexity?.score ?? 0, {
      id: "complexity",
      header: "복잡도",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.health_score, {
      id: "health",
      header: "상태 점수",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.decision_reason, {
      id: "reason",
      header: "결정 사유",
      cell: ({ getValue }) => (
        <span className="truncate" title={getValue()}>
          {getValue() || "—"}
        </span>
      ),
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => (
        <Button
          size="small"
          variant="ghost"
          aria-label={`${shortId(row.original.request_id)} 결정 상세 보기`}
          onClick={(event) => onOpen(row.original, event.currentTarget)}
        >
          상세 보기
        </Button>
      ),
    }),
  ]);
}

export function DecisionsTab(): React.JSX.Element {
  const [searchParams, updateSearch] = useSearchState();
  const limit = limitFrom(searchParams.get("limit"));
  const refreshInterval = useRefreshInterval();
  const [selectedId, setSelectedId] = useState<string>();
  const [detailTrigger, setDetailTrigger] = useState<HTMLElement | null>(null);

  const decisions = useQuery({
    queryKey: [...routingDecisionsQueryKey, limit],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.routing.decisions.list, {
        query: { limit },
        signal,
        routeId: "routing.rules",
      }),
    placeholderData: keepPreviousData,
    refetchInterval: refreshInterval,
  });

  const detail = useQuery({
    queryKey: [...routingDecisionsQueryKey, "detail", selectedId],
    queryFn: ({ signal }) =>
      apiClient.request(
        withPathParams(endpoints.domains.routing.decisions.detail, { id: selectedId ?? "" }),
        {
          signal,
          routeId: "routing.rules",
        },
      ),
    enabled: selectedId !== undefined,
  });

  const rows = decisions.data?.decisions ?? [];
  const selected = detail.data?.decision;

  return (
    <div className="routing-panel-stack">
      <Toolbar
        label="결정 이력 조회 조건"
        end={
          <Button onClick={() => void decisions.refetch()} disabled={decisions.isFetching}>
            <RefreshCw aria-hidden="true" /> {decisions.isFetching ? "갱신 중" : "새로고침"}
          </Button>
        }
      >
        <label className="form-field">
          <span>표시 개수</span>
          <select
            className="input select"
            value={limit}
            onChange={(event) => updateSearch({ limit: event.target.value })}
          >
            {limits.map((item) => (
              <option key={item} value={item}>
                {item}건
              </option>
            ))}
          </select>
        </label>
      </Toolbar>

      {decisions.isError ? (
        <QueryFailureNotice
          error={decisions.error}
          hasData={Boolean(decisions.data)}
          label="라우팅 결정 이력"
          onRetry={() => void decisions.refetch()}
        />
      ) : null}

      <SectionCard
        title="라우팅 결정 이력"
        description="실제 요청이 어떤 근거로 어떤 모델·공급자에 배정되었는지 기록입니다."
      >
        <DataTable
          caption="라우팅 결정 이력"
          columns={decisionColumns((decision, trigger) => {
            setDetailTrigger(trigger);
            setSelectedId(decision.id);
          })}
          data={rows}
          emptyMessage="기록된 라우팅 결정이 없습니다. 게이트웨이로 요청이 들어오면 이 목록이 채워집니다."
          error={decisions.isError && !decisions.data ? "결정 이력을 불러오지 못했습니다." : undefined}
          getRowId={(row, index) => row.id || String(index)}
          loading={decisions.isPending}
          onRetry={() => void decisions.refetch()}
        />
      </SectionCard>

      <Dialog
        description="선택한 요청의 라우팅 근거입니다."
        onOpenChange={(open) => {
          if (!open) setSelectedId(undefined);
        }}
        open={selectedId !== undefined}
        returnFocusRef={{ current: detailTrigger }}
        title="라우팅 결정 상세"
      >
        {detail.isPending ? (
          <p role="status">결정 상세를 불러오는 중입니다.</p>
        ) : detail.isError ? (
          <QueryFailureNotice
            error={detail.error}
            hasData={false}
            label="라우팅 결정 상세"
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <KeyValueList
            columns={1}
            items={[
              { label: "요청 ID", value: selected?.request_id, mono: true },
              { label: "트레이스 ID", value: selected?.trace_id, mono: true },
              { label: "시각", value: formatDateTime(selected?.created_at) },
              { label: "요청 모델", value: selected?.requested_model, mono: true },
              { label: "선택 모델", value: selected?.selected_model, mono: true },
              { label: "선택 공급자", value: selected?.selected_provider },
              {
                label: "복잡도",
                value: `${formatNumber(selected?.complexity?.score)} (${selected?.complexity?.tier ?? "—"})`,
              },
              {
                label: "위험",
                value: `${formatNumber(selected?.risk?.score)} (${selected?.risk?.tier ?? "—"})`,
              },
              { label: "상태 점수", value: formatNumber(selected?.health_score) },
              {
                label: "폴백 경로",
                value:
                  selected && selected.fallback_path.length > 0 ? selected.fallback_path.join(" → ") : "—",
              },
              { label: "결정 사유", value: selected?.decision_reason },
            ]}
          />
        )}
      </Dialog>
    </div>
  );
}
