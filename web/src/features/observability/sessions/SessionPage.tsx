import { RefreshCw, Search } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { FlightRecorderPanel } from "./FlightRecorderPanel";
import { SessionListResults } from "./SessionListResults";
import { useSessionListAccess, type SessionListAccess } from "./session-list-access";
import { useSessionList } from "./session-list-query";
import {
  defaultSessionDays,
  sessionDays,
  sessionListBlockedMessage,
  sessionListNotice,
} from "./session-list-state";
import { isAppError } from "@/shared/api/error";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { ErrorState } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Sheet } from "@/shared/components/ui/Sheet";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import "@/features/observability/observability.css";

export function SessionPage(): React.JSX.Element {
  const access = useSessionListAccess();
  return <SessionPageContent key={access.key} access={access} />;
}

function SessionPageContent({ access }: { access: SessionListAccess }): React.JSX.Element {
  const [params, updateParams] = useSearchState();
  const latestUpdate = useRef(updateParams);
  useLayoutEffect(() => {
    latestUpdate.current = updateParams;
  });
  const interval = useRefreshInterval();
  const days = sessionDays(params.get("days"));
  const keyword = params.get("q")?.trim() ?? "";
  const identity = JSON.stringify([params.get("days"), params.get("q")]);
  const openSessionId = params.get("session_id")?.trim() ?? "";
  const [draft, setDraft] = useState({
    identity,
    days: String(days),
    keyword,
    error: undefined as string | undefined,
  });
  if (draft.identity !== identity) setDraft({ identity, days: String(days), keyword, error: undefined });
  const [blocked, setBlocked] = useState<{ serial: number; count: number }>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const {
    result: sessions,
    rows,
    canOpen,
    refresh,
    filterSerial,
    successCount,
    ready,
  } = useSessionList(days, keyword, identity, access, interval);
  const showBlocked = blocked?.serial === filterSerial && !(ready && successCount !== blocked.count);
  const resetFilters = () => {
    setDraft({ identity, days: String(defaultSessionDays), keyword: "", error: undefined });
    setBlocked(undefined);
    updateParams({ days: undefined, q: undefined });
  };
  const submitFilters = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextDays = Number(draft.days);
    if (!Number.isInteger(nextDays) || nextDays < 1 || nextDays > 365) {
      setDraft({ ...draft, error: "조회 기간은 1일에서 365일 사이의 정수여야 합니다." });
      return;
    }
    if (containsPotentialSecret(draft.keyword, access.prefixes)) {
      setDraft({ ...draft, error: secretSearchMessage });
      return;
    }
    setDraft({ identity, days: String(nextDays), keyword: draft.keyword.trim(), error: undefined });
    setBlocked(undefined);
    updateParams({
      days: nextDays === defaultSessionDays ? undefined : nextDays,
      q: draft.keyword.trim() || undefined,
    });
  };
  if (!access.readable)
    return (
      <ErrorState
        title="세션 목록 조회 권한을 확인하세요."
        message="현재 세션 목록 조회 권한을 확인하세요."
        showLegacy={false}
      />
    );
  const requestId = isAppError(sessions.error) ? sessions.error.requestId : undefined;
  const safeRequestId =
    requestId && !containsPotentialSecret(requestId, access.prefixes) ? requestId : undefined;
  return (
    <div className="page-stack">
      <PageHeader
        title="세션 비행기록"
        description="코딩 세션 단위로 게이트웨이 요청을 시간순으로 재구성해 원인을 추적합니다."
        legacyHref="/admin#/sessions"
        actions={
          <Button onClick={refresh} disabled={sessions.isFetching}>
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
              value={draft.days}
              onChange={(event) => setDraft({ ...draft, days: event.target.value })}
            />
          </label>
          <label>
            세션 ID · 메시지 검색
            <Input
              name="q"
              value={draft.keyword}
              onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
              placeholder="세션 ID 또는 메시지 일부"
            />
          </label>
        </Toolbar>
      </form>
      {draft.error ? (
        <p className="form-error" role="alert">
          {draft.error}
        </p>
      ) : null}
      <section aria-label="목록 조회 기준">
        <p role="status">{sessionListNotice(days, sessions.data, sessions.isFetching, sessions.isError)}</p>
        <p>
          검색과 합계는 불러온 최대 200개 세션에 적용됩니다. 전체 세션 검색이나 기간 전체의 합계가 아닙니다.
        </p>
        <p aria-live="polite">
          {showBlocked
            ? sessionListBlockedMessage
            : "목록을 새로 확인하는 동안에는 새로운 세션을 선택할 수 없습니다."}
        </p>
      </section>
      {sessions.isError ? (
        <ErrorState
          message={
            sessions.data
              ? "최신 목록을 갱신하지 못해 마지막 정상 데이터를 표시합니다."
              : safeAppErrorMessage(sessions.error, "세션 목록을 불러오지 못했습니다.")
          }
          requestId={safeRequestId}
          onRetry={refresh}
          onReset={resetFilters}
          legacyHref="/admin#/sessions"
        />
      ) : null}
      {sessions.data || !sessions.isError ? (
        <SessionListResults
          data={sessions.data}
          rows={rows}
          pending={sessions.isPending}
          onReset={resetFilters}
          onOpen={(row) => {
            if (!canOpen(row)) {
              setBlocked({ serial: filterSerial, count: successCount });
              return;
            }
            setBlocked(undefined);
            returnFocusRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            latestUpdate.current({ session_id: row.session_id }, { replace: false });
          }}
        />
      ) : null}
      <Sheet
        open={openSessionId !== ""}
        onOpenChange={(next) => {
          if (!next) latestUpdate.current({ session_id: undefined }, { replace: false });
        }}
        returnFocusRef={returnFocusRef}
        size="wide"
        title="세션 비행기록"
        description="목록 기간과 별개인 세션의 제한된 최근 요청을 보여줍니다."
      >
        {openSessionId ? <FlightRecorderPanel sessionId={openSessionId} /> : null}
      </Sheet>
    </div>
  );
}
