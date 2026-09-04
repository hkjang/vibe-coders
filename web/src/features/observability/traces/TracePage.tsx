import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExternalLink, ListTree, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link, useLocation, useSearchParams } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { featureByPath } from "@/config/migration-registry";
import { TraceFilters } from "@/features/observability/traces/TraceFilters";
import { TraceRequestDetails } from "@/features/observability/traces/TraceRequestDetails";
import { TraceRequestTable } from "@/features/observability/traces/TraceRequestTable";
import { TraceTimeline } from "@/features/observability/traces/TraceTimeline";
import {
  buildTraceQuery,
  formatTraceDate,
  formatTraceDuration,
  requestExplorerPath,
  selectedRequestFromSearch,
  traceFilterFormKey,
  traceCount,
} from "@/features/observability/traces/trace-utils";
import { refreshIntervalMs } from "@/features/health/health-utils";
import { uiLabels } from "@/config/ui-labels";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { ErrorState, LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { usePreferences } from "@/shared/stores/preferences";
import "@/features/observability/traces/trace-page.css";

export function TracePage(): React.JSX.Element {
  const auth = useAuth();
  const location = useLocation();
  const runtimeFeature = featureByPath(location.pathname, auth.features) ?? featureByPath(location.pathname);
  const legacyPath = runtimeFeature?.legacyPath;
  const showLegacyAdmin =
    canOpenLegacyAdmin(auth) && runtimeFeature?.fallbackEnabled === true && legacyPath !== undefined;
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const interval = refreshIntervalMs(refreshInterval);
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useMemo(() => buildTraceQuery(searchParams), [searchParams]);
  const selectedTimeZone = query.tz ?? "Asia/Seoul";
  const selectedRequestId = selectedRequestFromSearch(searchParams);
  const filterFormKey = traceFilterFormKey(searchParams);
  const detailRef = useRef<HTMLElement>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const selectionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previousSelectedRequestIdRef = useRef<string | undefined>(undefined);

  const result = useQuery({
    queryKey: ["admin", "requests", "trace-explorer", query],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.requests, {
        query,
        signal,
        routeId: "observability.traces",
      }),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const selectionPresence = selectedRequestId
    ? result.data
      ? result.data.requests.some((request) => request.request_id === selectedRequestId)
        ? "found"
        : "missing"
      : "loading"
    : "none";

  const updateSearch = useCallback(
    (updates: Readonly<Record<string, string | undefined>>, replace = false): void => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(updates)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      setSearchParams(next, { replace });
    },
    [searchParams, setSearchParams],
  );

  const selectRequest = useCallback(
    (requestId: string, trigger: HTMLButtonElement): void => {
      selectionTriggerRef.current = trigger;
      if (selectedRequestId === requestId) {
        detailRef.current?.focus();
        return;
      }
      updateSearch({ selected_request: requestId }, false);
    },
    [selectedRequestId, updateSearch],
  );

  const clearSelectedRequest = useCallback((): void => {
    updateSearch({ selected_request: undefined }, true);
  }, [updateSearch]);

  const forgetSelectionTrigger = useCallback((): void => {
    selectionTriggerRef.current = null;
  }, []);

  useEffect(() => {
    const previousSelectedRequestId = previousSelectedRequestIdRef.current;
    previousSelectedRequestIdRef.current = selectedRequestId;
    if (selectedRequestId) {
      if (selectionPresence !== "loading") detailRef.current?.focus();
      return;
    }
    if (!previousSelectedRequestId) return;
    const target = selectionTriggerRef.current;
    selectionTriggerRef.current = null;
    if (target?.isConnected) target.focus();
    else pageHeadingRef.current?.focus();
  }, [selectedRequestId, selectionPresence]);

  if (result.isPending && !result.data) {
    return <LoadingState label="추적 요청 흐름을 불러오는 중입니다." />;
  }
  if (result.error && !result.data) {
    return (
      <ErrorState
        title="추적 요청 흐름을 불러오지 못했습니다."
        message={safeAppErrorMessage(result.error, "추적 요청 흐름을 확인할 수 없습니다.")}
        requestId={isAppError(result.error) ? result.error.requestId : undefined}
        diagnosticCode={isAppError(result.error) ? result.error.code : undefined}
        onRetry={() => void result.refetch()}
        onReset={() => setSearchParams({}, { replace: false })}
        resetLabel="필터 초기화"
        showLegacy={showLegacyAdmin}
        legacyHref={legacyPath}
      />
    );
  }

  const data = result.data;
  const requests = data?.requests ?? [];
  const selectedRequest = requests.find((request) => request.request_id === selectedRequestId);
  const requestedTraceId = query.trace_id;
  const averageLatency = requests.length
    ? requests.reduce((total, request) => total + request.latency_ms, 0) / requests.length
    : 0;
  const failedRequests = requests.filter(
    (request) => request.status_code >= 400 && request.status_code < 600,
  ).length;
  const explorerHref = requestExplorerPath(query, selectedRequestId);

  return (
    <div className="page-stack trace-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">관측 · {uiLabels.previewReadOnly}</p>
          <h1 ref={pageHeadingRef} tabIndex={-1}>
            추적 탐색기
          </h1>
          <p>같은 추적 ID로 연결된 요청의 시작 시점과 처리 지연을 요청 단위로 확인합니다.</p>
        </div>
        <div className="page-actions">
          <Badge tone="info">{uiLabels.readOnly}</Badge>
          <Link className="button button-secondary button-default" to={explorerHref}>
            <Search aria-hidden="true" /> 요청 탐색기
          </Link>
          {showLegacyAdmin && legacyPath ? (
            <a className="button button-secondary button-default" href={legacyPath}>
              <ExternalLink aria-hidden="true" /> 기존 화면 보기
            </a>
          ) : null}
          <Button variant="primary" disabled={result.isFetching} onClick={() => void result.refetch()}>
            <RefreshCw aria-hidden="true" /> {result.isFetching ? "갱신 중" : "새로고침"}
          </Button>
        </div>
      </header>

      <TraceFilters
        key={filterFormKey}
        query={query}
        credentialPrefixes={auth.credentialPrefixes}
        onApply={(next) => {
          forgetSelectionTrigger();
          setSearchParams(next, { replace: false });
        }}
        onReset={() => {
          forgetSelectionTrigger();
          setSearchParams({}, { replace: false });
        }}
      />

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {selectedRequestId
          ? selectedRequest
            ? `요청 ${selectedRequest.request_id} 상세가 열렸습니다.`
            : "선택한 요청이 현재 페이지에 없습니다."
          : ""}
      </p>

      {!requestedTraceId ? (
        <section className="trace-guidance" role="status" aria-labelledby="trace-guidance-title">
          <ListTree aria-hidden="true" />
          <div>
            <h2 id="trace-guidance-title">추적 ID로 요청 흐름을 좁혀 보세요.</h2>
            <p>
              현재는 최근 요청을 표시합니다. 추적 ID를 입력하면 같은 추적에 속한 요청만 시간순으로 확인할 수
              있습니다.
            </p>
          </div>
        </section>
      ) : null}

      {result.error && data ? (
        <div className="trace-stale" role="alert">
          <div>
            <strong>갱신에 실패해 마지막 정상 데이터를 표시합니다.</strong>
            {isAppError(result.error) && result.error.requestId ? (
              <code>요청 ID: {result.error.requestId}</code>
            ) : null}
          </div>
          <Button size="small" variant="secondary" onClick={() => void result.refetch()}>
            재시도
          </Button>
        </div>
      ) : null}
      {result.isPlaceholderData ? (
        <div className="trace-stale" role="status">
          새 필터를 조회하는 동안 직전 결과를 표시합니다.
        </div>
      ) : null}

      {requests.length ? (
        <>
          <section className="trace-summary" aria-label="추적 요청 요약">
            <article>
              <span>표시 요청</span>
              <strong>{requests.length.toLocaleString("ko-KR")}건</strong>
            </article>
            <article>
              <span>추적 ID</span>
              <strong>{traceCount(requests).toLocaleString("ko-KR")}개</strong>
            </article>
            <article>
              <span>평균 지연</span>
              <strong>{formatTraceDuration(Math.round(averageLatency))}</strong>
            </article>
            <article>
              <span>오류 요청</span>
              <strong>{failedRequests.toLocaleString("ko-KR")}건</strong>
            </article>
          </section>

          <TraceTimeline
            requests={requests}
            selectedRequestId={selectedRequestId}
            timeZone={selectedTimeZone}
            onSelect={selectRequest}
          />

          <TraceRequestTable
            requests={requests}
            selectedRequestId={selectedRequestId}
            timeZone={selectedTimeZone}
            onSelect={selectRequest}
          />

          <div className="trace-pagination">
            <span>
              마지막 갱신{" "}
              {data ? (
                <time data-testid="traces-generated-at" dateTime={data.generated_at}>
                  {formatTraceDate(data.generated_at, selectedTimeZone, { timeStyle: "medium" })}
                </time>
              ) : (
                "-"
              )}
            </span>
            <div>
              <Button
                variant="secondary"
                size="small"
                disabled={!data?.previous_cursor || result.isFetching}
                onClick={() => {
                  forgetSelectionTrigger();
                  updateSearch({ cursor: data?.previous_cursor, selected_request: undefined }, false);
                }}
              >
                이전
              </Button>
              <Button
                variant="secondary"
                size="small"
                disabled={!data?.next_cursor || result.isFetching}
                onClick={() => {
                  forgetSelectionTrigger();
                  updateSearch({ cursor: data?.next_cursor, selected_request: undefined }, false);
                }}
              >
                다음
              </Button>
            </div>
          </div>
        </>
      ) : (
        <section className="trace-empty" role="status">
          <ListTree aria-hidden="true" />
          <h2>{requestedTraceId ? "일치하는 추적 요청이 없습니다." : "최근 요청이 없습니다."}</h2>
          <p>
            {requestedTraceId
              ? "추적 ID와 조회 기간을 확인하거나 필터를 초기화해 보세요."
              : "요청이 기록되면 요청 단위 처리 흐름이 여기에 표시됩니다."}
          </p>
        </section>
      )}

      <TraceRequestDetails
        request={selectedRequest}
        detailRef={detailRef}
        selectedRequestId={selectedRequestId}
        timeZone={selectedTimeZone}
        requestExplorerHref={explorerHref}
        onClear={clearSelectedRequest}
      />
    </div>
  );
}
