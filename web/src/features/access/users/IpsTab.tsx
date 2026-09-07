import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { useIpsQuery } from "@/features/access/users/use-access-admin";
import { apiClient } from "@/shared/api/client";
import { withPathParams } from "@/shared/api/domains/access";
import type { IpSummary } from "@/shared/api/domains/access.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { LoadingState } from "@/shared/components/state/PageStates";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";

const access = endpoints.domains.access;
const routeId = "access.users";

function ipColumns(): ReadonlyArray<DataTableColumn<IpSummary>> {
  const column = createDataTableColumnHelper<IpSummary>();
  return column.columns([
    column.accessor((row) => row.ip, {
      id: "ip",
      header: "IP",
      cell: ({ getValue }) => <span className="mono">{getValue()}</span>,
    }),
    column.accessor((row) => row.distinct_keys, {
      id: "distinct_keys",
      header: "사용 키 수",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.tokens, {
      id: "tokens",
      header: "토큰",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.cost_krw, {
      id: "cost",
      header: "비용",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
    column.accessor((row) => row.average_latency_ms, {
      id: "latency",
      header: "평균 지연",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}ms</span>,
    }),
    column.accessor((row) => row.last_seen, {
      id: "last_seen",
      header: "최근 사용",
      cell: ({ getValue }) => formatDateTime(getValue()),
    }),
  ]);
}

export function IpsTab(): React.JSX.Element {
  const ips = useIpsQuery(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const detailTrigger = useRef<HTMLElement>(null);

  const detail = useQuery({
    queryKey: ["access", "ips", "detail", selected],
    enabled: selected !== "",
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(access.ips.detail, { ip: selected }), {
        query: { limit: 100 },
        signal,
        routeId,
      }),
  });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = ips.data?.ips ?? [];
    return needle ? all.filter((row) => row.ip.toLowerCase().includes(needle)) : all;
  }, [ips.data?.ips, search]);

  if (ips.isPending && !ips.data) return <LoadingState label="IP 사용량을 불러오는 중입니다." />;

  const all = ips.data?.ips ?? [];

  return (
    <div className="access-stack">
      {ips.isError ? (
        <QueryNotice
          error={ips.error}
          hasData={Boolean(ips.data)}
          label="IP 목록"
          onRetry={() => void ips.refetch()}
        />
      ) : null}

      <StatGrid label="IP 요약">
        <StatCard label="관측된 IP" value={formatNumber(all.length)} />
        <StatCard label="총 요청" value={formatNumber(all.reduce((sum, row) => sum + row.requests, 0))} />
        <StatCard label="총 비용" value={formatKRW(all.reduce((sum, row) => sum + row.cost_krw, 0))} />
      </StatGrid>

      <InlineNotice tone="info" title="IP 차단 기능은 서버에 없습니다.">
        IP 단위 차단·해제 API가 제공되지 않습니다. 특정 IP만 허용하려면 API 키 탭에서 키를 발급할 때 허용 IP
        목록을 지정하세요. 이미 발급된 키의 허용 IP는 변경할 수 없으므로 새 키를 발급해야 합니다.
      </InlineNotice>

      <SectionCard
        title="IP별 사용량"
        description="서버가 상위 200개 IP만 집계합니다. 행을 선택하면 상세 사용 내역을 볼 수 있습니다."
      >
        <Toolbar label="IP 필터">
          <label className="access-toolbar-field">
            <span>IP 검색</span>
            <Input value={search} placeholder="10.0." onChange={(event) => setSearch(event.target.value)} />
          </label>
        </Toolbar>
        <DataTable
          caption="IP별 사용량"
          columns={ipColumns()}
          data={rows}
          getRowId={(row) => row.ip}
          getRowActionLabel={(row) => `${row.ip} 상세 열기`}
          onRowClick={(row) => {
            detailTrigger.current = document.activeElement as HTMLElement | null;
            setSelected(row.ip);
          }}
          emptyMessage="집계된 IP 사용량이 없습니다."
        />
        <UpdatedAt at={ips.dataUpdatedAt} />
      </SectionCard>

      <Sheet
        open={selected !== ""}
        onOpenChange={(open) => {
          if (!open) setSelected("");
        }}
        returnFocusRef={detailTrigger}
        size="wide"
        title={selected || "IP 상세"}
        description="선택한 IP의 사용량, 모델·키 분포와 최근 호출입니다."
      >
        {detail.isPending ? <LoadingState label="IP 상세를 불러오는 중입니다." /> : null}
        {detail.isError ? (
          <InlineNotice tone="danger" title="IP 상세를 불러오지 못했습니다.">
            {safeAppErrorMessage(detail.error, "잠시 후 다시 시도하세요.")}
            {isAppError(detail.error) && detail.error.requestId ? (
              <span className="request-id"> 요청 ID: {detail.error.requestId}</span>
            ) : null}
          </InlineNotice>
        ) : null}
        {detail.data ? (
          <div className="access-stack">
            {detail.data.stats ? <JsonBlock label="사용량 통계" value={detail.data.stats} /> : null}
            <SectionCard title="API 키별 사용" headingLevel={3}>
              {detail.data.by_key.length === 0 ? (
                <p className="access-note">기록된 값이 없습니다.</p>
              ) : (
                <ul className="access-list">
                  {detail.data.by_key.slice(0, 20).map((row, index) => (
                    <li key={`${row.api_key_id}-${String(index)}`}>
                      <span className="access-list-title">{row.name || row.api_key_id}</span>
                      <span className="access-list-detail">
                        요청 {formatNumber(row.requests)} · {formatKRW(row.cost_krw)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
            <SectionCard title="모델별 사용" headingLevel={3}>
              {detail.data.by_model.length === 0 ? (
                <p className="access-note">기록된 값이 없습니다.</p>
              ) : (
                <ul className="access-list">
                  {detail.data.by_model.slice(0, 20).map((row, index) => (
                    <li key={`${row.model}-${String(index)}`}>
                      <span className="access-list-title">{row.model || "—"}</span>
                      <span className="access-list-detail">
                        요청 {formatNumber(row.requests)} · {formatKRW(row.cost_krw)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
