import { ExternalLink, LockKeyhole, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { ProviderDetailDialog } from "@/features/gateway/providers/ProviderDetailDialog";
import {
  buildProviderRows,
  filterProviderRows,
  isProviderStatusFilter,
  type ProviderCatalogRow,
  type ProviderStatusFilter,
} from "@/features/gateway/providers/provider-catalog";
import { ProviderTable, QueryFailureNotice } from "@/features/gateway/providers/ProviderTableParts";
import { useProviderCatalogQueries } from "@/features/gateway/providers/use-provider-catalog";
import { useProviderDialogFocus } from "@/features/gateway/providers/use-provider-dialog-focus";
import { formatInteger, isHealthRange, maxUpdatedAt, type HealthRange } from "@/features/health/health-utils";
import { TimeRangePicker } from "@/features/health/health-ui";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";

const pageSize = 10;
const defaultRange: HealthRange = "24h";

const statusLabels: Record<ProviderStatusFilter, string> = {
  all: "전체 상태",
  enabled: "활성",
  disabled: "비활성",
  healthy: "Healthy",
  degraded: "Degraded",
  unknown: "Unknown",
};

function positivePage(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function ProviderPage(): React.JSX.Element {
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedRange = searchParams.get("range");
  const requestedStatus = searchParams.get("status");
  const requestedPage = searchParams.get("page");
  const range = isHealthRange(requestedRange) ? requestedRange : defaultRange;
  const status = isProviderStatusFilter(requestedStatus) ? requestedStatus : "all";
  const query = searchParams.get("q") ?? "";
  const selectedName = searchParams.get("provider")?.trim() ?? "";
  const currentPage = positivePage(requestedPage);
  const canReadRouting = auth.user?.scopes.includes("routing:read") ?? false;
  const showLegacyAdmin = canOpenLegacyAdmin(auth);
  const { providers, routing, slo } = useProviderCatalogQueries(range, canReadRouting);

  const updateSearch = useCallback(
    (updates: Readonly<Record<string, string | undefined>>, replace = true): void => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === "") next.delete(key);
        else next.set(key, value);
      }
      setSearchParams(next, { replace });
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    const updates: Record<string, string | undefined> = {};
    if (requestedRange !== null && !isHealthRange(requestedRange)) updates.range = defaultRange;
    if (requestedStatus !== null && !isProviderStatusFilter(requestedStatus)) updates.status = undefined;
    if (requestedPage !== null && positivePage(requestedPage) === 1 && requestedPage !== "1") {
      updates.page = undefined;
    }
    if (Object.keys(updates).length > 0) updateSearch(updates);
  }, [requestedPage, requestedRange, requestedStatus, updateSearch]);

  const allRows = useMemo(
    () =>
      buildProviderRows(
        providers.data?.providers ?? [],
        slo.data?.slos,
        slo.data?.evaluations,
        canReadRouting ? routing.data : undefined,
      ).sort(
        (left, right) =>
          left.provider.priority - right.provider.priority ||
          left.provider.name.localeCompare(right.provider.name),
      ),
    [canReadRouting, providers.data?.providers, routing.data, slo.data?.evaluations, slo.data?.slos],
  );
  const filteredRows = useMemo(() => filterProviderRows(allRows, query, status), [allRows, query, status]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const page = Math.min(currentPage, pageCount);
  const pageRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);
  const selectedRow = allRows.find((row) => row.provider.name === selectedName);
  const updatedAt = maxUpdatedAt(
    providers.dataUpdatedAt,
    slo.dataUpdatedAt,
    canReadRouting ? routing.dataUpdatedAt : 0,
  );
  const refreshing = providers.isFetching || slo.isFetching || (canReadRouting && routing.isFetching);

  useEffect(() => {
    if (!providers.data || currentPage <= pageCount) return;
    updateSearch({ page: pageCount === 1 ? undefined : String(pageCount) });
  }, [currentPage, pageCount, providers.data, updateSearch]);

  const { closeProvider, rememberRowTrigger, rememberTrigger, returnFocusRef } = useProviderDialogFocus(
    selectedName,
    updateSearch,
  );
  const openProvider = useCallback(
    (row: ProviderCatalogRow): void => {
      rememberRowTrigger(row.provider.name);
      updateSearch({ provider: row.provider.name }, false);
    },
    [rememberRowTrigger, updateSearch],
  );
  const detailSearch = useCallback(
    (provider: string): string => {
      const next = new URLSearchParams(searchParams);
      next.set("provider", provider);
      return `?${next.toString()}`;
    },
    [searchParams],
  );
  const refreshAll = (): void => {
    void Promise.all([providers.refetch(), slo.refetch(), ...(canReadRouting ? [routing.refetch()] : [])]);
  };

  const enabledCount = allRows.filter((row) => row.provider.enabled).length;
  const degradedCount = allRows.filter((row) => row.health === "degraded").length;
  const unknownCount = allRows.filter((row) => row.health === "unknown").length;

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <div className="eyebrow">Preview Read Only</div>
          <h1>Provider</h1>
          <p>AI Provider 연결 설정과 SLO, 선택 기간의 운영 상태를 안전하게 조회합니다.</p>
        </div>
        <div className="page-actions">
          <Badge tone="info">Read Only</Badge>
          {showLegacyAdmin ? (
            <a className="button button-secondary button-default" href="/admin#/settings">
              Legacy에서 열기 <ExternalLink aria-hidden="true" />
            </a>
          ) : null}
          <Button variant="primary" onClick={refreshAll} disabled={refreshing}>
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        </div>
      </header>

      <section className="provider-summary" aria-label="Provider 요약">
        <article>
          <span>전체 Provider</span>
          <strong>{formatInteger(allRows.length)}</strong>
        </article>
        <article>
          <span>활성</span>
          <strong>{formatInteger(enabledCount)}</strong>
        </article>
        <article>
          <span>Degraded</span>
          <strong>{formatInteger(degradedCount)}</strong>
        </article>
        <article>
          <span>상태 미확인</span>
          <strong>{formatInteger(unknownCount)}</strong>
        </article>
      </section>

      <div className="provider-toolbar">
        <form
          className="provider-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const submittedQuery = new FormData(event.currentTarget).get("q");
            updateSearch({
              q: typeof submittedQuery === "string" ? submittedQuery.trim() || undefined : undefined,
              page: undefined,
            });
          }}
        >
          <label htmlFor="provider-search">Provider 검색</label>
          <div>
            <Search aria-hidden="true" />
            <input
              key={query}
              id="provider-search"
              name="q"
              defaultValue={query}
              placeholder="이름, URL, 모델 패턴, Failover Group"
            />
            <Button size="small" type="submit">
              검색
            </Button>
          </div>
        </form>
        <label className="provider-filter">
          <span>상태</span>
          <select
            value={status}
            onChange={(event) =>
              updateSearch({
                status: event.target.value === "all" ? undefined : event.target.value,
                page: undefined,
              })
            }
          >
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="provider-range">
          <span>조회 기간</span>
          <TimeRangePicker
            value={range}
            onChange={(nextRange) => updateSearch({ range: nextRange, page: undefined })}
          />
        </div>
        <Button
          size="small"
          variant="ghost"
          onClick={() => updateSearch({ q: undefined, status: undefined, page: undefined })}
        >
          필터 초기화
        </Button>
      </div>

      {!canReadRouting ? (
        <div className="provider-permission-note" role="status">
          <LockKeyhole aria-hidden="true" />
          <p>
            <strong>라우팅 상세 신호는 제한되어 있습니다.</strong>
            <span>SLO 평가만 표시합니다. 전체 상태 점수는 routing:read 권한이 필요합니다.</span>
          </p>
        </div>
      ) : null}

      {providers.isError ? (
        <QueryFailureNotice
          error={providers.error}
          hasPreviousData={Boolean(providers.data)}
          label="Provider 목록"
          onRetry={() => void providers.refetch()}
        />
      ) : null}
      {slo.isError ? (
        <QueryFailureNotice
          error={slo.error}
          hasPreviousData={Boolean(slo.data)}
          label="Provider SLO"
          onRetry={() => void slo.refetch()}
        />
      ) : null}
      {canReadRouting && routing.isError ? (
        <QueryFailureNotice
          error={routing.error}
          hasPreviousData={Boolean(routing.data)}
          label="Provider 라우팅 상태"
          onRetry={() => void routing.refetch()}
        />
      ) : null}

      <ProviderTable
        allRowCount={allRows.length}
        detailSearch={detailSearch}
        filteredRowCount={filteredRows.length}
        loading={providers.isPending}
        onPageChange={(pageIndex) =>
          updateSearch({ page: pageIndex === 0 ? undefined : String(pageIndex + 1) })
        }
        onRowClick={openProvider}
        pageCount={pageCount}
        pageIndex={page - 1}
        providerUnavailable={providers.isError && !providers.data}
        rememberTrigger={rememberTrigger}
        rows={pageRows}
        updatedAt={updatedAt}
      />

      <ProviderDetailDialog
        canReadRouting={canReadRouting}
        error={providers.error}
        loading={providers.isPending}
        onOpenChange={(open) => {
          if (!open) closeProvider();
        }}
        open={selectedName !== ""}
        requestedName={selectedName}
        returnFocusRef={returnFocusRef}
        row={selectedRow}
        showLegacyAdmin={showLegacyAdmin}
      />
    </div>
  );
}
