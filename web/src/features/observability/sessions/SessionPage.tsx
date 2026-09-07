import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { FlightRecorderPanel } from "@/features/observability/sessions/FlightRecorderPanel";
import { apiClient } from "@/shared/api/client";
import type { SessionSummary } from "@/shared/api/domains/observability.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { ErrorState } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatKRW, formatNumber, formatRelative } from "@/shared/utils/format";
import "@/features/observability/observability.css";

const defaultDays = 7;

function daysFromParam(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : defaultDays;
}

const sessionColumns = ((): ReadonlyArray<DataTableColumn<SessionSummary>> => {
  const column = createDataTableColumnHelper<SessionSummary>();
  return column.columns([
    column.display({
      id: "session_id",
      header: "세션 ID",
      cell: ({ row }) => (
        <span className="mono truncate" title={row.original.session_id}>
          {row.original.session_id || "—"}
        </span>
      ),
    }),
    column.display({
      id: "last_message",
      header: "마지막 메시지",
      cell: ({ row }) => (
        <span className="truncate" title={row.original.last_message}>
          {row.original.last_message || "—"}
        </span>
      ),
    }),
    column.display({
      id: "requests",
      header: "요청",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.requests)}</span>,
    }),
    column.display({
      id: "errors",
      header: "오류",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.errors)}</span>,
    }),
    column.display({
      id: "models",
      header: "모델 수",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.models)}</span>,
    }),
    column.display({
      id: "total_tokens",
      header: "토큰",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.total_tokens)}</span>,
    }),
    column.display({
      id: "cost_krw",
      header: "비용",
      cell: ({ row }) => <span className="cell-number">{formatKRW(row.original.cost_krw)}</span>,
    }),
    column.display({
      id: "last_seen",
      header: "마지막 활동",
      cell: ({ row }) => (
        <span title={formatDateTime(row.original.last_seen)}>{formatRelative(row.original.last_seen)}</span>
      ),
    }),
  ]);
})();

export function SessionPage(): React.JSX.Element {
  const [params, updateParams] = useSearchState();
  const interval = useRefreshInterval();
  const days = daysFromParam(params.get("days"));
  const keyword = params.get("q")?.trim() ?? "";
  const openSessionId = params.get("session_id")?.trim() ?? "";
  const [daysInput, setDaysInput] = useState(String(days));
  const [keywordInput, setKeywordInput] = useState(keyword);
  const [filterError, setFilterError] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const sessions = useQuery({
    queryKey: ["observability", "sessions", days],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.sessions.list, {
        query: { days },
        signal,
        routeId: "observability.sessions",
      }),
    placeholderData: keepPreviousData,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });

  const rows = useMemo(() => {
    const all = sessions.data?.sessions ?? [];
    if (keyword === "") return all;
    const needle = keyword.toLowerCase();
    return all.filter(
      (row) =>
        row.session_id.toLowerCase().includes(needle) || row.last_message.toLowerCase().includes(needle),
    );
  }, [keyword, sessions.data]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (accumulator, row) => ({
          requests: accumulator.requests + row.requests,
          errors: accumulator.errors + row.errors,
          tokens: accumulator.tokens + row.total_tokens,
          cost: accumulator.cost + row.cost_krw,
        }),
        { requests: 0, errors: 0, tokens: 0, cost: 0 },
      ),
    [rows],
  );

  const submitFilters = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const nextDays = Number(daysInput);
    if (!Number.isInteger(nextDays) || nextDays < 1 || nextDays > 365) {
      setFilterError("조회 기간은 1일에서 365일 사이의 정수여야 합니다.");
      return;
    }
    if (containsPotentialSecret(keywordInput)) {
      setFilterError(secretSearchMessage);
      return;
    }
    setFilterError(undefined);
    updateParams({
      days: nextDays === defaultDays ? undefined : nextDays,
      q: keywordInput.trim() || undefined,
    });
  };

  const resetFilters = (): void => {
    setDaysInput(String(defaultDays));
    setKeywordInput("");
    setFilterError(undefined);
    updateParams({ days: undefined, q: undefined });
  };

  const openRecorder = (sessionId: string): void => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    updateParams({ session_id: sessionId }, { replace: false });
  };

  const unavailable = sessions.isError && sessions.data === undefined;
  if (unavailable) {
    return (
      <div className="page-stack">
        <PageHeader
          title="세션 비행기록"
          description="코딩 세션과 요청 흐름을 시간순으로 재생합니다."
          legacyHref="/admin#/sessions"
        />
        <ErrorState
          message={safeAppErrorMessage(sessions.error, "세션 목록을 불러오지 못했습니다.")}
          requestId={isAppError(sessions.error) ? sessions.error.requestId : undefined}
          onRetry={() => void sessions.refetch()}
          onReset={resetFilters}
          legacyHref="/admin#/sessions"
        />
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="세션 비행기록"
        description="코딩 세션 단위로 게이트웨이 요청을 시간순으로 재구성해 원인을 추적합니다."
        legacyHref="/admin#/sessions"
        actions={
          <Button onClick={() => void sessions.refetch()} disabled={sessions.isFetching}>
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      <form onSubmit={submitFilters}>
        <Toolbar
          label="세션 검색"
          end={
            <>
              <Button type="submit" variant="primary">
                <Search aria-hidden="true" /> 조회
              </Button>
              <Button type="button" onClick={resetFilters}>
                초기화
              </Button>
            </>
          }
        >
          <label>
            조회 기간(일)
            <Input
              name="days"
              type="number"
              min={1}
              max={365}
              value={daysInput}
              onChange={(event) => setDaysInput(event.target.value)}
            />
          </label>
          <label>
            세션 ID · 메시지 검색
            <Input
              name="q"
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              placeholder="세션 ID 또는 메시지 일부"
            />
          </label>
        </Toolbar>
      </form>
      {filterError ? (
        <p className="form-error" role="alert">
          {filterError}
        </p>
      ) : null}

      {sessions.isError ? (
        <p className="form-error" role="alert">
          최신 목록을 갱신하지 못해 마지막 정상 데이터를 표시합니다.
        </p>
      ) : null}

      <StatGrid label="세션 요약">
        <StatCard label="세션" value={formatNumber(rows.length)} hint={`최근 ${days}일`} />
        <StatCard label="요청" value={formatNumber(totals.requests)} />
        <StatCard
          label="오류"
          value={formatNumber(totals.errors)}
          tone={totals.errors > 0 ? "warning" : "default"}
        />
        <StatCard label="비용" value={formatKRW(totals.cost)} />
      </StatGrid>

      <SectionCard
        title="최근 세션"
        description={sessions.data?.note ?? "세션을 선택하면 비행기록 타임라인이 열립니다."}
      >
        {!sessions.isPending && rows.length === 0 ? (
          <EmptyState
            title="표시할 세션이 없습니다."
            description="개발도구가 session_id 헤더와 함께 요청을 보내면 세션이 만들어집니다. 조회 기간을 늘려 보세요."
            actions={
              <Button onClick={resetFilters} variant="secondary">
                필터 초기화
              </Button>
            }
          />
        ) : (
          <DataTable
            caption="최근 코딩 세션"
            columns={sessionColumns}
            data={rows}
            getRowId={(row, index) => row.session_id || String(index)}
            loading={sessions.isPending}
            onRowClick={(row) => openRecorder(row.session_id)}
            getRowActionLabel={(row) => `${row.session_id} 세션 비행기록 열기`}
          />
        )}
      </SectionCard>

      <Sheet
        open={openSessionId !== ""}
        onOpenChange={(next) => {
          if (!next) updateParams({ session_id: undefined }, { replace: false });
        }}
        returnFocusRef={returnFocusRef}
        size="wide"
        title="세션 비행기록"
        description="세션에서 일어난 요청을 시간순으로 보여줍니다. 프롬프트 원문은 포함되지 않습니다."
      >
        {openSessionId ? <FlightRecorderPanel sessionId={openSessionId} /> : null}
      </Sheet>
    </div>
  );
}
