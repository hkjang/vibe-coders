import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExternalLink, Filter, RefreshCw, Search } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { featureByPath } from "@/config/migration-registry";
import { RequestDetailDialog } from "@/features/observability/requests/RequestDetailDialog";
import { formatRequestDate } from "@/features/observability/requests/request-date";
import { refreshIntervalMs } from "@/features/health/health-utils";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import type { AppRequestSummary, AppRequestsQuery } from "@/shared/api/schemas";
import { ErrorState, LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { usePreferences } from "@/shared/stores/preferences";
import { httpStatusTone } from "@/shared/utils/http-status";
import { isValidIPAddress } from "@/shared/utils/ip-address";
import { requestQueryFieldError } from "@/shared/utils/request-query-filters";
import { isValidRequestTimeZone, validateRequestTimeFilters } from "@/shared/utils/request-time-filters";
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
const defaultLimit = 50;
const defaultTimeZone = "Asia/Seoul";
const exactHTTPStatusPattern = /^[1-5][0-9]{2}$/u;
const standardPageLimits = [25, 50, 100, 200] as const;

function queryFromSearch(search: URLSearchParams): AppRequestsQuery {
  const requestedLimit = Number(search.get("limit"));
  const temporalError = validateRequestTimeFilters({
    from: search.get("from") ?? undefined,
    to: search.get("to") ?? undefined,
    tz: search.get("tz") ?? undefined,
  });
  const requestedTimeZone = search.get("tz")?.trim() ?? "";
  const query: AppRequestsQuery = {
    limit:
      Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 200
        ? requestedLimit
        : defaultLimit,
    tz: isValidRequestTimeZone(requestedTimeZone) ? requestedTimeZone : defaultTimeZone,
  };
  for (const key of filterKeys) {
    const value = search.get(key)?.trim();
    if (value && requestQueryFieldError(key, value)) continue;
    if ((key === "from" || key === "to") && temporalError?.field === key) continue;
    if (value) Object.assign(query, { [key]: value });
  }
  const cursor = search.get("cursor");
  if (cursor && !requestQueryFieldError("cursor", cursor)) query.cursor = cursor;
  return query;
}

function RequestIPFilter({ initialValue }: { initialValue: string }): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  const error = value.trim() !== "" && !isValidIPAddress(value) ? "올바른 IP 주소를 입력하세요." : "";

  return (
    <label>
      클라이언트 IP
      <input
        name="ip"
        aria-label="클라이언트 IP"
        value={value}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? "request-ip-error" : undefined}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      {error ? (
        <span id="request-ip-error" className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function RequestPage(): React.JSX.Element {
  const auth = useAuth();
  const location = useLocation();
  const runtimeFeature = featureByPath(location.pathname, auth.features) ?? featureByPath(location.pathname);
  const legacyPath = runtimeFeature?.legacyPath;
  const showLegacyAdmin =
    canOpenLegacyAdmin(auth) && runtimeFeature?.fallbackEnabled === true && legacyPath !== undefined;
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const interval = refreshIntervalMs(refreshInterval);
  const [searchParams, setSearchParams] = useSearchParams();
  const searchKey = searchParams.toString();
  const query = useMemo(() => queryFromSearch(searchParams), [searchParams]);
  const selectedTimeZone = query.tz ?? defaultTimeZone;
  const selectedStatus = query.status ?? "";
  const selectedLimit = query.limit ?? defaultLimit;
  const customStatus = exactHTTPStatusPattern.test(selectedStatus) ? selectedStatus : undefined;
  const customLimit = standardPageLimits.includes(selectedLimit as (typeof standardPageLimits)[number])
    ? undefined
    : selectedLimit;
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
  const [filterRevision, setFilterRevision] = useState(0);
  const [filterError, setFilterError] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const deepLinkIP = searchParams.get("ip")?.trim() ?? "";
  const deepLinkIPError = deepLinkIP !== "" && !isValidIPAddress(deepLinkIP);

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
    for (const key of [...filterKeys, "limit", "tz"] as const) {
      const value = String(form.get(key) ?? "").trim();
      if (value !== "" && containsPotentialSecret(value, auth.credentialPrefixes)) {
        setFilterError(secretSearchMessage);
        const control = event.currentTarget.elements.namedItem(key);
        if (control instanceof HTMLElement) control.focus();
        return;
      }
    }
    for (const key of [...filterKeys, "limit", "tz"] as const) {
      const value = String(form.get(key) ?? "").trim();
      const validationError = requestQueryFieldError(key, value);
      if (validationError) {
        if (key !== "ip") setFilterError(validationError);
        const control = event.currentTarget.elements.namedItem(key);
        if (control instanceof HTMLElement) control.focus();
        return;
      }
    }
    const temporalError = validateRequestTimeFilters({
      from: String(form.get("from") ?? ""),
      to: String(form.get("to") ?? ""),
      tz: String(form.get("tz") ?? ""),
    });
    if (temporalError) {
      setFilterError(temporalError.message);
      const control = event.currentTarget.elements.namedItem(temporalError.field);
      if (control instanceof HTMLElement) control.focus();
      return;
    }
    setFilterError(undefined);
    const submittedIP = String(form.get("ip") ?? "").trim();
    if (submittedIP !== "" && !isValidIPAddress(submittedIP)) {
      const ipInput = event.currentTarget.elements.namedItem("ip");
      if (ipInput instanceof HTMLInputElement) ipInput.focus();
      return;
    }
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
        message={safeAppErrorMessage(result.error, "요청 목록을 확인할 수 없습니다.")}
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
          {showLegacyAdmin && legacyPath ? (
            <a className="button button-secondary button-default" href={legacyPath}>
              <ExternalLink aria-hidden="true" /> 기존 화면 보기
            </a>
          ) : null}
        </div>
      </header>

      <form
        className="request-filters"
        key={`${searchKey}:${filterRevision}`}
        onInput={() => setFilterError(undefined)}
        onSubmit={submitFilters}
      >
        <div className="request-filter-heading">
          <Filter aria-hidden="true" />
          <strong>조회 필터</strong>
          <span>필터와 페이지 위치는 URL에 저장됩니다.</span>
        </div>
        <div className="request-filter-grid">
          <label>
            시작 시각
            <input
              name="from"
              type="text"
              maxLength={64}
              placeholder="예: 2026-09-04T09:00 또는 RFC3339"
              defaultValue={query.from ?? ""}
            />
          </label>
          <label>
            종료 시각
            <input
              name="to"
              type="text"
              maxLength={64}
              placeholder="예: 2026-09-04T18:00 또는 RFC3339"
              defaultValue={query.to ?? ""}
            />
          </label>
          <label>
            상태
            <select name="status" defaultValue={selectedStatus}>
              <option value="">전체</option>
              <option value="success">성공 (2xx·3xx)</option>
              <option value="error">오류 (4xx·5xx)</option>
              <option value="4xx">4xx</option>
              <option value="5xx">5xx</option>
              {customStatus ? <option value={customStatus}>HTTP {customStatus}</option> : null}
            </select>
          </label>
          <label>
            모델
            <input name="model" maxLength={256} defaultValue={searchParams.get("model") ?? ""} />
          </label>
          <label>
            요청 ID
            <input name="request_id" maxLength={512} defaultValue={searchParams.get("request_id") ?? ""} />
          </label>
          <label>
            공급자 참조
            <input name="provider_ref" maxLength={47} defaultValue={searchParams.get("provider_ref") ?? ""} />
          </label>
          <details className="request-advanced" open={deepLinkIPError || undefined}>
            <summary>고급 필터</summary>
            <div className="request-filter-grid">
              <label>
                추적 ID
                <input name="trace_id" maxLength={512} defaultValue={searchParams.get("trace_id") ?? ""} />
              </label>
              <label>
                세션 ID
                <input
                  name="session_id"
                  maxLength={512}
                  defaultValue={searchParams.get("session_id") ?? ""}
                />
              </label>
              <label>
                API 키 ID
                <input
                  name="api_key_id"
                  maxLength={512}
                  defaultValue={searchParams.get("api_key_id") ?? ""}
                />
              </label>
              <RequestIPFilter initialValue={deepLinkIP} />
              <label>
                언어
                <input name="language" maxLength={64} defaultValue={searchParams.get("language") ?? ""} />
              </label>
              <label>
                표시 건수
                <select name="limit" defaultValue={String(selectedLimit)}>
                  {customLimit ? <option value={customLimit}>{customLimit}건</option> : null}
                  <option value="25">25건</option>
                  <option value="50">50건</option>
                  <option value="100">100건</option>
                  <option value="200">200건</option>
                </select>
              </label>
              <label>
                시간대
                <input name="tz" defaultValue={selectedTimeZone} />
              </label>
            </div>
          </details>
        </div>
        {filterError ? (
          <p className="field-error" role="alert">
            {filterError}
          </p>
        ) : null}
        <div className="request-filter-actions">
          <Button type="submit" variant="primary">
            <Search aria-hidden="true" /> 조회
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setFilterError(undefined);
              setFilterRevision((revision) => revision + 1);
              setSearchParams({}, { replace: false });
            }}
          >
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
                    <td>
                      <time
                        data-testid={`request-created-at-${request.request_id}`}
                        dateTime={request.created_at}
                      >
                        {formatRequestDate(request.created_at, selectedTimeZone, {
                          dateStyle: "short",
                          timeStyle: "medium",
                        })}
                      </time>
                    </td>
                    <td>
                      <Badge tone={httpStatusTone(request.status_code)}>{request.status_code}</Badge>
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
            {data ? (
              <time data-testid="requests-generated-at" dateTime={data.generated_at}>
                {formatRequestDate(data.generated_at, selectedTimeZone, { timeStyle: "medium" })}
              </time>
            ) : (
              "-"
            )}
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
        legacyHref={showLegacyAdmin ? legacyPath : undefined}
        timeZone={selectedTimeZone}
      />
    </section>
  );
}
