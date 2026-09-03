import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExternalLink, Filter, RefreshCw, Search } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { RequestDetailDialog } from "@/features/observability/requests/RequestDetailDialog";
import { refreshIntervalMs } from "@/features/health/health-utils";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import type { AppRequestSummary, AppRequestsQuery } from "@/shared/api/schemas";
import { ErrorState, LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { usePreferences } from "@/shared/stores/preferences";
import "@/features/observability/requests/request-page.css";

const filterKeys = [
  "from",
  "to",
  "status",
  "model",
  "provider_ref",
  "request_id",
  "trace_id",
  "session_id",
  "api_key_id",
  "ip",
  "language",
] as const;

function queryFromSearch(search: URLSearchParams): AppRequestsQuery {
  const query: AppRequestsQuery = {
    limit: Number(search.get("limit") ?? 50),
    tz: search.get("tz") ?? "Asia/Seoul",
  };
  for (const key of filterKeys) {
    const value = search.get(key);
    if (value) Object.assign(query, { [key]: value });
  }
  const cursor = search.get("cursor");
  if (cursor) query.cursor = cursor;
  return query;
}

function statusTone(code: number): "success" | "warning" | "danger" {
  if (code < 400) return "success";
  return code < 500 ? "warning" : "danger";
}

function formatDate(value: string, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "확인 불가" : new Intl.DateTimeFormat("ko-KR", options).format(date);
}

export function RequestPage(): React.JSX.Element {
  const auth = useAuth();
  const showLegacyAdmin = canOpenLegacyAdmin(auth);
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const interval = refreshIntervalMs(refreshInterval);
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useMemo(() => queryFromSearch(searchParams), [searchParams]);
  const result = useQuery({
    queryKey: ["admin", "requests", query],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.requests, { query, signal, routeId: "observability.requests" }),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const [selected, setSelected] = useState<AppRequestSummary>();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const updateCursor = useCallback(
    (cursor?: string) => {
      const next = new URLSearchParams(searchParams);
      if (cursor) next.set("cursor", cursor);
      else next.delete("cursor");
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams],
  );

  const submitFilters = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    for (const key of [...filterKeys, "limit", "tz"] as const) {
      const value = String(form.get(key) ?? "").trim();
      if (value) next.set(key, value);
    }
    setSearchParams(next, { replace: false });
  };

  const openRequest = (request: AppRequestSummary, trigger: HTMLElement): void => {
    returnFocusRef.current = trigger;
    setSelected(request);
  };

  if (result.isPending && !result.data) return <LoadingState label="최근 요청을 불러오는 중입니다." />;
  if (result.error && !result.data) {
    return (
      <ErrorState
        message={isAppError(result.error) ? result.error.message : "잠시 후 다시 시도해 주세요."}
        requestId={isAppError(result.error) ? result.error.requestId : undefined}
        onRetry={() => void result.refetch()}
        showLegacy={showLegacyAdmin}
      />
    );
  }

  const data = result.data;
  return (
    <section className="page-stack request-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">관측 · 읽기 전용 미리보기</p>
          <h1>요청 탐색기</h1>
          <p>프롬프트와 원시 오류를 제외한 최근 요청 운영 메타데이터를 조회합니다.</p>
        </div>
        <div className="page-actions">
          <Button variant="secondary" disabled={result.isFetching} onClick={() => void result.refetch()}>
            <RefreshCw aria-hidden="true" /> {result.isFetching ? "갱신 중" : "새로고침"}
          </Button>
          {showLegacyAdmin ? (
            <a className="button button-secondary button-default" href="/admin#/requests">
              <ExternalLink aria-hidden="true" /> 기존 화면 보기
            </a>
          ) : null}
        </div>
      </header>

      <form className="request-filters" key={searchParams.toString()} onSubmit={submitFilters}>
        <div className="request-filter-heading">
          <Filter aria-hidden="true" />
          <strong>조회 필터</strong>
          <span>필터와 페이지 위치는 URL에 저장됩니다.</span>
        </div>
        <div className="request-filter-grid">
          <label>
            시작 시각
            <input name="from" type="datetime-local" defaultValue={searchParams.get("from") ?? ""} />
          </label>
          <label>
            종료 시각
            <input name="to" type="datetime-local" defaultValue={searchParams.get("to") ?? ""} />
          </label>
          <label>
            상태
            <select name="status" defaultValue={searchParams.get("status") ?? ""}>
              <option value="">전체</option>
              <option value="success">성공 (2xx·3xx)</option>
              <option value="error">오류 (4xx·5xx)</option>
              <option value="4xx">4xx</option>
              <option value="5xx">5xx</option>
            </select>
          </label>
          <label>
            모델
            <input name="model" defaultValue={searchParams.get("model") ?? ""} />
          </label>
          <label>
            요청 ID
            <input name="request_id" defaultValue={searchParams.get("request_id") ?? ""} />
          </label>
          <label>
            공급자 참조
            <input name="provider_ref" defaultValue={searchParams.get("provider_ref") ?? ""} />
          </label>
          <details className="request-advanced">
            <summary>고급 필터</summary>
            <div className="request-filter-grid">
              <label>
                추적 ID
                <input name="trace_id" defaultValue={searchParams.get("trace_id") ?? ""} />
              </label>
              <label>
                세션 ID
                <input name="session_id" defaultValue={searchParams.get("session_id") ?? ""} />
              </label>
              <label>
                API 키 ID
                <input name="api_key_id" defaultValue={searchParams.get("api_key_id") ?? ""} />
              </label>
              <label>
                클라이언트 IP
                <input name="ip" defaultValue={searchParams.get("ip") ?? ""} />
              </label>
              <label>
                언어
                <input name="language" defaultValue={searchParams.get("language") ?? ""} />
              </label>
              <label>
                표시 건수
                <select name="limit" defaultValue={searchParams.get("limit") ?? "50"}>
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="200">200</option>
                </select>
              </label>
              <label>
                시간대
                <input name="tz" defaultValue={searchParams.get("tz") ?? "Asia/Seoul"} />
              </label>
            </div>
          </details>
        </div>
        <div className="request-filter-actions">
          <Button type="submit" variant="primary">
            <Search aria-hidden="true" /> 조회
          </Button>
          <Button type="button" variant="ghost" onClick={() => setSearchParams({}, { replace: false })}>
            필터 초기화
          </Button>
        </div>
      </form>

      {result.error && data ? (
        <div className="request-stale" role="alert">
          <strong>갱신에 실패해 마지막 정상 데이터를 표시합니다.</strong>
          {isAppError(result.error) && result.error.requestId ? (
            <code>요청 ID: {result.error.requestId}</code>
          ) : null}
          <Button size="small" variant="secondary" onClick={() => void result.refetch()}>
            재시도
          </Button>
        </div>
      ) : null}
      {result.isPlaceholderData ? (
        <div className="request-stale" role="status">
          새 필터를 조회하는 동안 직전 결과를 표시합니다.
        </div>
      ) : null}

      <div className="data-table-shell">
        <div className="data-table-scroll">
          <table className="data-table request-table">
            <thead>
              <tr>
                <th>시각</th>
                <th>상태</th>
                <th>요청 ID</th>
                <th>모델</th>
                <th>공급자</th>
                <th>지연</th>
                <th>토큰</th>
                <th>비용</th>
                <th>
                  <span className="sr-only">작업</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.requests.length ? (
                data.requests.map((request) => (
                  <tr key={request.request_id}>
                    <td>{formatDate(request.created_at, { dateStyle: "short", timeStyle: "medium" })}</td>
                    <td>
                      <Badge tone={statusTone(request.status_code)}>{request.status_code}</Badge>
                    </td>
                    <td>
                      <code>{request.request_id}</code>
                    </td>
                    <td>{request.model || "-"}</td>
                    <td>{request.provider_display}</td>
                    <td>{request.latency_ms.toLocaleString("ko-KR")}ms</td>
                    <td>{request.total_tokens.toLocaleString("ko-KR")}</td>
                    <td>
                      {request.estimated_cost.toLocaleString("ko-KR")} {request.currency}
                    </td>
                    <td>
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={(event) => openRequest(request, event.currentTarget)}
                      >
                        상세
                      </Button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="data-table-state" colSpan={9}>
                    조건에 맞는 요청이 없습니다. 기간이나 필터를 조정해 보세요.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="data-table-pagination">
          <span>
            {data?.requests.length ?? 0}건 · 마지막 갱신{" "}
            {data ? formatDate(data.generated_at, { timeStyle: "medium" }) : "-"}
          </span>
          <Button
            variant="secondary"
            size="small"
            disabled={!data?.previous_cursor || result.isFetching}
            onClick={() => updateCursor(data?.previous_cursor)}
          >
            이전
          </Button>
          <Button
            variant="secondary"
            size="small"
            disabled={!data?.next_cursor || result.isFetching}
            onClick={() => updateCursor(data?.next_cursor)}
          >
            다음
          </Button>
        </div>
      </div>
      <RequestDetailDialog
        open={Boolean(selected)}
        request={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
        returnFocusRef={returnFocusRef}
        showLegacy={showLegacyAdmin}
      />
    </section>
  );
}
