import { LegacyLink } from "@/shared/components/ui/LegacyLink";
import { ExternalLink, LockKeyhole, Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { useProviderWriteAccess } from "./use-provider-write-access";
import "@/features/gateway/gateway.css";
import { ProviderDetailDialog } from "@/features/gateway/providers/ProviderDetailDialog";
import { useProviderAdministration } from "@/features/gateway/providers/use-provider-administration";
import {
  buildProviderRows,
  filterProviderRows,
  isProviderStatusFilter,
  isSafeProviderCatalogName,
  providerStatusLabels as statusLabels,
  providerPageNumber as positivePage,
  type ProviderCatalogRow,
} from "@/features/gateway/providers/provider-catalog";
import {
  ProviderTable,
  ProviderSummary,
  ProviderQueryNotices,
} from "@/features/gateway/providers/ProviderTableParts";
import { useProviderCatalogQueries } from "@/features/gateway/providers/use-provider-catalog";
import { useProviderDialogFocus } from "@/features/gateway/providers/use-provider-dialog-focus";
import { isHealthRange, type HealthRange } from "@/features/health/health-utils";
import { TimeRangePicker } from "@/features/health/health-ui";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { uiLabels } from "@/config/ui-labels";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { isProviderRef } from "@/shared/api/provider-ref";
import { rejectedSensitiveQuery } from "@/shared/security/app-route-query";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";

const pageSize = 10;
const defaultRange: HealthRange = "24h";

export function ProviderPage(): React.JSX.Element {
  const auth = useAuth();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedRange = searchParams.get("range");
  const requestedStatus = searchParams.get("status");
  const requestedPage = searchParams.get("page");
  const requestedQuery = searchParams.get("q") ?? "";
  const range = isHealthRange(requestedRange) ? requestedRange : defaultRange;
  const status = isProviderStatusFilter(requestedStatus) ? requestedStatus : "all";
  const unsafeStoredQuery = containsPotentialSecret(requestedQuery, auth.credentialPrefixes);
  const query = unsafeStoredQuery ? "" : requestedQuery;
  const requestedProvider = searchParams.get("provider")?.trim() ?? "";
  const invalidRequestedProvider =
    requestedProvider !== "" &&
    !isProviderRef(requestedProvider) &&
    !isSafeProviderCatalogName(requestedProvider, auth.credentialPrefixes);
  const selectedRef = isProviderRef(requestedProvider) ? requestedProvider : "";
  const currentPage = positivePage(requestedPage);
  const canReadRouting = auth.user?.scopes.includes("routing:read") ?? false;
  const canWrite = useProviderWriteAccess().allowed;
  const showLegacyAdmin = canOpenLegacyAdmin(auth);
  const { providers, routing, slo } = useProviderCatalogQueries(range, canReadRouting);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchError, setSearchError] = useState<string | undefined>();
  const rejectedSearchNavigation =
    rejectedSensitiveQuery(location.state, "q") ||
    (typeof location.state === "object" &&
      location.state !== null &&
      "providerSearchRejected" in location.state &&
      location.state.providerSearchRejected === true);
  const rejectedProviderDetail =
    typeof location.state === "object" &&
    location.state !== null &&
    "providerDetailRejected" in location.state &&
    location.state.providerDetailRejected === true;
  const visibleSearchError =
    searchError ?? (unsafeStoredQuery || rejectedSearchNavigation ? secretSearchMessage : undefined);

  const updateSearch = useCallback(
    (updates: Readonly<Record<string, string | undefined>>, replace = true, state?: unknown): void => {
      const next = new URLSearchParams(searchParams);
      if (containsPotentialSecret(next.get("q") ?? "", auth.credentialPrefixes)) next.delete("q");
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === "") next.delete(key);
        else next.set(key, value);
      }
      setSearchParams(next, { replace, state });
    },
    [searchParams, setSearchParams, auth.credentialPrefixes],
  );

  useEffect(() => {
    const updates: Record<string, string | undefined> = {};
    if (requestedRange !== null && !isHealthRange(requestedRange)) updates.range = defaultRange;
    if (requestedStatus !== null && !isProviderStatusFilter(requestedStatus)) updates.status = undefined;
    if (unsafeStoredQuery) updates.q = undefined;
    if (invalidRequestedProvider) updates.provider = undefined;
    if (requestedPage !== null && positivePage(requestedPage) === 1 && requestedPage !== "1") {
      updates.page = undefined;
    }
    if (Object.keys(updates).length > 0) {
      updateSearch(updates, true, {
        ...(unsafeStoredQuery ? { providerSearchRejected: true } : {}),
        ...(invalidRequestedProvider ? { providerDetailRejected: true } : {}),
      });
    }
  }, [
    requestedPage,
    invalidRequestedProvider,
    requestedRange,
    requestedStatus,
    unsafeStoredQuery,
    updateSearch,
  ]);

  useEffect(() => {
    if (visibleSearchError) searchInputRef.current?.focus();
  }, [visibleSearchError]);

  const healthPending =
    Boolean(providers.data) &&
    (canReadRouting ? routing.isPending || (!routing.data && slo.isPending) : slo.isPending);

  const allRows = useMemo(
    () =>
      buildProviderRows(
        providers.data?.providers ?? [],
        slo.data?.slos,
        slo.data?.evaluations,
        canReadRouting ? routing.data : undefined,
        healthPending,
        auth.credentialPrefixes,
      ).sort(
        (left, right) =>
          left.provider.priority - right.provider.priority ||
          left.displayName.localeCompare(right.displayName),
      ),
    [
      canReadRouting,
      healthPending,
      providers.data?.providers,
      routing.data,
      slo.data?.evaluations,
      slo.data?.slos,
      auth.credentialPrefixes,
    ],
  );
  const filteredRows = useMemo(
    () => filterProviderRows(allRows, query, status, auth.credentialPrefixes),
    [allRows, query, status, auth.credentialPrefixes],
  );
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const page = Math.min(currentPage, pageCount);
  const pageRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);
  const selectedRow = allRows.find((row) => row.identity === selectedRef);
  const refreshing = providers.isFetching || slo.isFetching || (canReadRouting && routing.isFetching);

  useEffect(() => {
    if (!providers.data || currentPage <= pageCount) return;
    updateSearch({ page: pageCount === 1 ? undefined : String(pageCount) });
  }, [currentPage, pageCount, providers.data, updateSearch]);

  useEffect(() => {
    if (requestedProvider === "" || isProviderRef(requestedProvider)) return;
    if (!providers.data) return;
    const legacyMatches = isSafeProviderCatalogName(requestedProvider, auth.credentialPrefixes)
      ? allRows.filter((row) => !row.nameRedacted && row.provider.name === requestedProvider)
      : [];
    updateSearch(
      { provider: legacyMatches.length === 1 ? legacyMatches[0]?.identity : undefined },
      true,
      legacyMatches.length === 1 ? undefined : { providerDetailRejected: true },
    );
  }, [allRows, providers.data, requestedProvider, updateSearch, auth.credentialPrefixes]);

  const { closeProvider, rememberRowTrigger, rememberTrigger, returnFocusRef } = useProviderDialogFocus(
    selectedRef,
    updateSearch,
  );
  const openProvider = useCallback(
    (row: ProviderCatalogRow): void => {
      rememberRowTrigger(row.identity);
      updateSearch({ provider: row.identity }, false);
    },
    [rememberRowTrigger, updateSearch],
  );
  const detailSearch = useCallback(
    (provider: string): string => {
      const next = new URLSearchParams(searchParams);
      if (containsPotentialSecret(next.get("q") ?? "", auth.credentialPrefixes)) next.delete("q");
      next.set("provider", provider);
      return `?${next.toString()}`;
    },
    [searchParams, auth.credentialPrefixes],
  );
  const refreshAll = (): void => {
    void Promise.all([providers.refetch(), slo.refetch(), ...(canReadRouting ? [routing.refetch()] : [])]);
  };

  const {
    createButtonRef,
    openCreate,
    renderRowActions,
    dialogs: adminDialogs,
    writeDeniedReason,
  } = useProviderAdministration(canWrite, auth.credentialPrefixes);
  const providerSummaryUnavailable = providers.isPending || (providers.isError && !providers.data);

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <div className="eyebrow">{canWrite ? "미리보기" : uiLabels.previewReadOnly}</div>
          <h1>공급자</h1>
          <p>AI 공급자 연결과 SLO를 등록·수정하고 선택 기간의 운영 상태를 확인합니다.</p>
        </div>
        <div className="page-actions">
          {canWrite ? null : <Badge tone="info">{uiLabels.readOnly}</Badge>}
          {showLegacyAdmin ? (
            <LegacyLink className="button button-secondary button-default" href="/admin#/settings">
              기존 화면에서 열기 <ExternalLink aria-hidden="true" />
            </LegacyLink>
          ) : null}
          <Button
            ref={createButtonRef}
            variant="primary"
            disabled={!canWrite}
            title={writeDeniedReason}
            onClick={openCreate}
          >
            <Plus aria-hidden="true" /> 공급자 추가
          </Button>
          <Button onClick={refreshAll} disabled={refreshing}>
            <RefreshCw aria-hidden="true" /> {refreshing ? "갱신 중" : "새로고침"}
          </Button>
        </div>
      </header>

      <ProviderSummary
        rows={allRows}
        unavailable={providerSummaryUnavailable}
        healthPending={healthPending}
      />
      <div className="provider-toolbar">
        <form
          className="provider-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const submittedQuery = new FormData(event.currentTarget).get("q");
            const nextQuery = typeof submittedQuery === "string" ? submittedQuery.trim() : "";
            if (containsPotentialSecret(nextQuery, auth.credentialPrefixes)) {
              setSearchError(secretSearchMessage);
              searchInputRef.current?.focus();
              return;
            }
            setSearchError(undefined);
            updateSearch({
              q: nextQuery || undefined,
              page: undefined,
            });
          }}
        >
          <label htmlFor="provider-search">공급자 검색</label>
          <div>
            <Search aria-hidden="true" />
            <input
              ref={searchInputRef}
              key={query}
              id="provider-search"
              name="q"
              defaultValue={query}
              placeholder="이름, URL, 모델 패턴, 장애 전환 그룹"
              aria-describedby={visibleSearchError ? "provider-search-error" : undefined}
              aria-invalid={visibleSearchError ? "true" : undefined}
              onChange={() => {
                if (searchError) setSearchError(undefined);
              }}
            />
            <Button size="small" type="submit">
              검색
            </Button>
          </div>
          {visibleSearchError ? (
            <p id="provider-search-error" className="provider-search-error" role="alert">
              {visibleSearchError}
            </p>
          ) : null}
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

      <ProviderQueryNotices
        providers={providers}
        slo={slo}
        routing={routing}
        canReadRouting={canReadRouting}
      />
      <ProviderTable
        credentialPrefixes={auth.credentialPrefixes}
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
        renderActions={renderRowActions}
        rows={pageRows}
        updatedAt={providers.dataUpdatedAt}
      />

      <ProviderDetailDialog
        credentialPrefixes={auth.credentialPrefixes}
        canReadRouting={canReadRouting}
        onOpenChange={(open) => {
          if (!open) {
            if (rejectedProviderDetail) updateSearch({ provider: undefined }, true, null);
            else closeProvider();
          }
        }}
        open={selectedRef !== "" || rejectedProviderDetail}
        returnFocusRef={returnFocusRef}
        row={selectedRow}
        showLegacyAdmin={showLegacyAdmin}
        providerState={{
          error: providers.error,
          hasData: Boolean(providers.data),
          pending: providers.isPending,
          refreshing: providers.isFetching && !providers.isPending,
          onRetry: () => void providers.refetch(),
        }}
        sloState={{
          error: slo.error,
          hasData: Boolean(slo.data),
          pending: slo.isPending,
          refreshing: slo.isFetching && !slo.isPending,
          onRetry: () => void slo.refetch(),
        }}
        routingState={{
          error: routing.error,
          hasData: Boolean(routing.data),
          pending: routing.isPending,
          refreshing: routing.isFetching && !routing.isPending,
          onRetry: () => void routing.refetch(),
        }}
      />
      {adminDialogs}
    </div>
  );
}
