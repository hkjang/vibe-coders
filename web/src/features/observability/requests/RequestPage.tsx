import { FeatureLegacyLink } from "@/shared/components/ui/FeatureLegacyLink";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { featureByPath } from "@/config/migration-registry";
import { RequestDetailDialog } from "@/features/observability/requests/RequestDetailDialog";
import { refreshIntervalMs } from "@/features/health/health-utils";
import { isAppError } from "@/shared/api/error";
import { useTraceSafeFlowAccess, type TraceSafeFlowAccess } from "../traces/trace-safe-flow-access";
import { requestSelectionIdentity, useRequestSafeFlowSelection } from "./request-safe-flow-selection";
import { RequestFilters } from "./RequestFilters";
import { RequestActiveFilters } from "./RequestActiveFilters";
import { withoutRequestFilter } from "./request-filter-summary";
import { defaultTimeZone, filterKeys, queryFromSearch } from "./request-page-query";
import { RequestResultsTable } from "./RequestResultsTable";
import { RequestSavedFilters } from "./saved-filters/RequestSavedFilters";
import { ErrorState, LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { MigrationEyebrow } from "@/shared/components/page/MigrationStatus";
import { Button } from "@/shared/components/ui/Button";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { usePreferences } from "@/shared/stores/preferences";
import { isValidIPAddress } from "@/shared/utils/ip-address";
import { requestQueryFieldError } from "@/shared/utils/request-query-filters";
import { validateRequestTimeFilters } from "@/shared/utils/request-time-filters";
import "@/features/observability/requests/request-page.css";

export function RequestPage(): React.JSX.Element {
  const access = useTraceSafeFlowAccess("observability.requests");
  return <RequestPageContent key={access.key} access={access} />;
}

function RequestPageContent({ access }: { access: TraceSafeFlowAccess }): React.JSX.Element {
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
  const [selecting, setSelecting] = useState(false);
  const selection = useRequestSafeFlowSelection(query, access, interval, selecting);
  const { result, selected: activeSelected } = selection;
  const [filterRevision, setFilterRevision] = useState(0);
  const [filterError, setFilterError] = useState<string>();
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastTarget = useRef<string | undefined>(undefined);
  const returnFocusRef = useMemo(
    () => ({
      get current() {
        const trigger = lastTarget.current ? rowRefs.current.get(lastTarget.current) : undefined;
        return trigger?.isConnected && !trigger.disabled ? trigger : resultsHeadingRef.current;
      },
    }),
    [],
  );
  const errorHeadingRef = useRef<HTMLHeadingElement>(null);
  const pendingPageFocusRef = useRef(false);
  const pageErrorFocusedRef = useRef(false);
  const pendingErrorActionFocusRef = useRef<"reset" | "retry" | undefined>(undefined);
  const errorRetryButtonRef = useRef<HTMLButtonElement>(null);
  const errorResetButtonRef = useRef<HTMLButtonElement>(null);

  const updateCursor = useCallback(
    (cursor?: string) => {
      const next = new URLSearchParams(searchParams);
      if (cursor) next.set("cursor", cursor);
      else next.delete("cursor");
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    if (!pendingPageFocusRef.current || result.isFetching || result.isPlaceholderData) return;
    if (resultsHeadingRef.current) {
      pendingPageFocusRef.current = false;
      pageErrorFocusedRef.current = false;
      pendingErrorActionFocusRef.current = undefined;
      resultsHeadingRef.current.focus();
      return;
    }
    const errorActionTarget =
      pendingErrorActionFocusRef.current === "retry"
        ? errorRetryButtonRef.current
        : pendingErrorActionFocusRef.current === "reset"
          ? errorResetButtonRef.current
          : undefined;
    if (errorActionTarget) {
      pendingErrorActionFocusRef.current = undefined;
      errorActionTarget.focus();
      return;
    }
    if (!pageErrorFocusedRef.current && errorHeadingRef.current) {
      pageErrorFocusedRef.current = true;
      errorHeadingRef.current.focus();
    }
  }, [
    query.cursor,
    result.dataUpdatedAt,
    result.errorUpdatedAt,
    result.isFetching,
    result.isPlaceholderData,
  ]);

  useEffect(() => {
    if (selection.denied) errorHeadingRef.current?.focus();
  }, [selection.denied]);

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

  if (!access.readable)
    return <ErrorState message="현재 화면의 요청 조회 권한을 확인할 수 없습니다." showLegacy={false} />;
  if (selection.denied || (result.error && !result.data)) {
    return (
      <ErrorState
        legacyFeatureId="observability.requests"
        headingRef={errorHeadingRef}
        message={
          selection.denied
            ? "현재 요청 목록의 조회가 거부되었습니다. 권한을 확인한 뒤 다시 조회하세요."
            : safeAppErrorMessage(result.error, "요청 목록을 확인할 수 없습니다.")
        }
        requestId={
          selection.denied
            ? selection.denialRequestId
            : isAppError(result.error)
              ? result.error.requestId
              : undefined
        }
        diagnosticCode={isAppError(result.error) ? result.error.code : undefined}
        onRetry={() => {
          pendingPageFocusRef.current = true;
          pendingErrorActionFocusRef.current = "retry";
          selection.refresh();
        }}
        onReset={() => {
          pendingPageFocusRef.current = true;
          pendingErrorActionFocusRef.current = "reset";
          setSearchParams({}, { replace: false });
        }}
        retryButtonRef={errorRetryButtonRef}
        resetButtonRef={errorResetButtonRef}
        resetLabel="필터 초기화"
        showLegacy={showLegacyAdmin}
        legacyHref={legacyPath}
      />
    );
  }
  if (result.isPending && !result.data) return <LoadingState label="최근 요청을 불러오는 중입니다." />;

  const data = result.data?.response;
  return (
    <section className="page-stack request-page">
      <header className="page-header">
        <div>
          <MigrationEyebrow fallbackStatus="preview" prefix="관측" />
          <h1>요청 탐색기</h1>
          <p>프롬프트와 원시 오류를 제외한 최근 요청 운영 메타데이터를 조회합니다.</p>
        </div>
        <div className="page-actions">
          <Badge tone="info">요청 기록 읽기 전용</Badge>
          <Button variant="secondary" disabled={result.isFetching} onClick={selection.refresh}>
            <RefreshCw aria-hidden="true" /> {result.isFetching ? "갱신 중" : "새로고침"}
          </Button>
          {showLegacyAdmin && legacyPath ? (
            <FeatureLegacyLink
              featureId="observability.requests"
              className="button button-secondary button-default"
              href={legacyPath}
            >
              <ExternalLink aria-hidden="true" /> 기존 화면 보기
            </FeatureLegacyLink>
          ) : null}
        </div>
      </header>

      <RequestSavedFilters
        query={query}
        onApply={(params) => {
          setFilterError(undefined);
          setFilterRevision((value) => value + 1);
          pendingPageFocusRef.current = true;
          setSearchParams(params, { replace: false });
        }}
      />

      <RequestFilters
        key={`${searchKey}:${filterRevision}`}
        query={query}
        searchParams={searchParams}
        filterError={filterError}
        onSubmit={submitFilters}
        onInput={() => setFilterError(undefined)}
        onReset={() => {
          setFilterError(undefined);
          setFilterRevision((revision) => revision + 1);
          setSearchParams({}, { replace: false });
        }}
      />

      <RequestActiveFilters
        query={query}
        credentialPrefixes={auth.credentialPrefixes}
        current={selection.ready}
        onRemove={(key) => {
          setFilterError(undefined);
          pendingPageFocusRef.current = true;
          setSearchParams(withoutRequestFilter(searchParams, key), { replace: false });
        }}
      />

      {result.error && data ? (
        <div className="request-stale" role="alert">
          <strong>갱신에 실패해 마지막 정상 데이터를 표시합니다.</strong>
          {isAppError(result.error) && result.error.requestId ? (
            <code>요청 ID: {result.error.requestId}</code>
          ) : null}
          <Button size="small" variant="secondary" onClick={selection.refresh}>
            재시도
          </Button>
        </div>
      ) : null}
      {result.isPlaceholderData ? (
        <div className="request-stale" role="status">
          새 필터를 조회하는 동안 직전 결과를 표시합니다.
        </div>
      ) : null}
      {data?.request_contract_version === 1 ? (
        <div className="request-contract-warning" role="status">
          <strong>서버 배포 버전을 맞추는 중입니다.</strong>
          <span>
            요청 목록은 계속 조회할 수 있지만 추적 화면 연결은 모든 서버가 v0.83.0 이상이 된 뒤 제공됩니다.
          </span>
        </div>
      ) : null}

      <h2 ref={resultsHeadingRef} className="sr-only" tabIndex={-1}>
        요청 조회 결과
      </h2>

      <RequestResultsTable
        data={data}
        frame={selection.frame}
        ready={selection.ready}
        fetching={result.isFetching}
        isDataCurrent={selection.isDataCurrent}
        timeZone={selectedTimeZone}
        selecting={selecting}
        onSelecting={setSelecting}
        onCursor={(cursor) => {
          pendingPageFocusRef.current = true;
          updateCursor(cursor);
        }}
        onOpen={(request, ordinal) => {
          if (selection.open(request, ordinal)) lastTarget.current = requestSelectionIdentity(request);
        }}
        onRowRef={(request, node) => {
          const identity = requestSelectionIdentity(request);
          if (node) rowRefs.current.set(identity, node);
          else rowRefs.current.delete(identity);
        }}
      />
      <RequestDetailDialog
        open={Boolean(activeSelected)}
        request={activeSelected?.request}
        requestOrdinal={activeSelected?.ordinal}
        traceHandoffEnabled={data?.request_contract_version === 2}
        flowReady={selection.ready}
        flowGeneration={activeSelected?.generation ?? 0}
        flowSelection={activeSelected?.serial ?? 0}
        assertFlowSelection={selection.assertSelected}
        onOpenChange={(open) => {
          if (!open) selection.close();
        }}
        returnFocusRef={returnFocusRef}
        legacyHref={showLegacyAdmin ? legacyPath : undefined}
        timeZone={selectedTimeZone}
      />
    </section>
  );
}
