import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { Sheet } from "@/shared/components/ui/Sheet";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { ErrorState } from "@/shared/components/state/PageStates";
import { isAppError } from "@/shared/api/error";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { readSessionPage } from "./session-page-state";
import { useSessionPage } from "./use-session-page";
import { SessionPageTable } from "./SessionPageTable";
import { FlightRecorderPanel } from "./FlightRecorderPanel";
import { SessionReadDenied } from "./SessionReadDenied";
import "@/features/observability/observability.css";
import "./session-page.css";

export function PagedSessionPage() {
  const auth = useAuth();
  const [search, setSearch] = useSearchParams();
  const { valid, query } = readSessionPage(search, auth.credentialPrefixes);
  const marker = JSON.stringify([
    search.getAll("days"),
    search.getAll("q"),
    search.getAll("page_size"),
    search.getAll("offset"),
  ]);
  const owner = useFeatureReadOwner("observability.sessions", marker);
  const { result, canOpen } = useSessionPage(query, owner, valid);
  const [draft, setDraft] = useState({
    marker,
    days: search.get("days") ?? "7",
    q: search.get("q") ?? "",
    error: "",
  });
  if (draft.marker !== marker)
    setDraft({ marker, days: search.get("days") ?? "7", q: search.get("q") ?? "", error: "" });
  const focus = useRef<HTMLElement | null>(null);
  const page = result.isError ? undefined : result.data;
  const previousDisabled = result.isFetching || query.offset === 0;
  const nextDisabled =
    result.isFetching ||
    !page ||
    query.offset + query.limit >= page.summary.sessions ||
    query.offset + query.limit > 1_000_000;
  const openSession = search.get("session_id") ?? "";
  const update = (changes: Record<string, string | undefined>) => {
    if (!owner.isCurrent()) return;
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) next.delete(key);
      else next.set(key, value);
    }
    setSearch(next);
  };
  const reset = () => {
    if (!owner.isCurrent()) return;
    // Clearing absent URL parameters does not change marker. Reset local edits
    // and validation explicitly even when the applied filters are already empty.
    setDraft({ marker, days: "7", q: "", error: "" });
    update({ days: undefined, q: undefined, offset: undefined, page_size: undefined });
  };
  const refresh = () => {
    if (owner.isCurrent() && valid && !result.isFetching) void result.refetch({ cancelRefetch: false });
  };
  if (!owner.readable || owner.denied) return <SessionReadDenied onRetry={owner.restart} />;
  const errorID = isAppError(result.error) ? result.error.requestId : undefined;
  return (
    <div className="page-stack">
      <PageHeader
        title="세션 비행기록"
        description="기간 전체의 세션을 검색하고 요청·오류·비용을 확인합니다."
        legacyHref="/admin#/sessions"
        actions={
          <Button disabled={!valid || result.isFetching} onClick={refresh}>
            새로고침
          </Button>
        }
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const next = new URLSearchParams({
            days: draft.days,
            q: draft.q.trim(),
            page_size: String(query.limit),
            offset: "0",
          });
          if (!readSessionPage(next, auth.credentialPrefixes).valid) {
            setDraft({
              ...draft,
              error:
                "기간은 1~365일, 검색어는 민감 정보를 제외한 세션 ID 일부를 256바이트 이내로 입력하세요.",
            });
            return;
          }
          update({ days: draft.days, q: draft.q.trim() || undefined, offset: undefined });
        }}
      >
        <Toolbar
          label="세션 검색"
          end={
            <>
              <Button type="submit" variant="primary">
                조회
              </Button>
              <Button type="button" onClick={reset}>
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
              onChange={(event) => setDraft({ ...draft, days: event.target.value, error: "" })}
            />
          </label>
          <label>
            세션 ID 검색
            <Input
              name="q"
              value={draft.q}
              onChange={(event) => setDraft({ ...draft, q: event.target.value, error: "" })}
              placeholder="세션 ID 일부"
            />
          </label>
          <label>
            페이지당 세션 수
            <Select
              value={query.limit}
              onChange={(event) => update({ page_size: event.target.value, offset: undefined })}
            >
              {[25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size}개
                </option>
              ))}
            </Select>
          </label>
        </Toolbar>
      </form>
      {draft.error ? (
        <p role="alert" className="form-error">
          {draft.error}
        </p>
      ) : null}
      <p>
        검색과 합계는 현재 권한으로 조회 가능한 기간 전체에 적용됩니다. 메시지 내용은 검색하지 않습니다. 새
        기록으로 페이지 위치가 달라질 수 있습니다.
      </p>
      {!valid ? (
        <ErrorState
          title="세션 조회 주소를 확인하세요."
          message="기간, 검색어, 페이지 크기와 위치를 확인하세요."
          onReset={reset}
          showLegacy={false}
        />
      ) : result.isError ? (
        <ErrorState
          title="세션 목록을 불러오지 못했습니다."
          message="권한과 서버 상태를 확인한 뒤 다시 조회하세요. 전체 건수와 합계를 확인할 수 없습니다."
          requestId={
            errorID && !containsPotentialSecret(errorID, auth.credentialPrefixes) ? errorID : undefined
          }
          onRetry={refresh}
          legacyHref="/admin#/sessions"
        />
      ) : (
        <>
          {page ? (
            <>
              <StatGrid label="검색 범위 전체 세션 요약">
                <StatCard
                  label="전체 세션"
                  value={formatNumber(page.summary.sessions)}
                  hint={`최근 ${page.days}일 · 세션 ID 검색 적용`}
                />
                <StatCard label="전체 요청" value={formatNumber(page.summary.requests)} />
                <StatCard
                  label="전체 오류"
                  value={formatNumber(page.summary.errors)}
                  tone={page.summary.errors > 0 ? "warning" : "default"}
                />
                <StatCard label="전체 비용" value={formatKRW(page.summary.cost_krw)} />
              </StatGrid>
              <p role="status">
                {formatDateTime(page.from)} 이상 ~ {formatDateTime(page.to)} 미만 · 전체 토큰{" "}
                {formatNumber(page.summary.total_tokens)}개 · 현재 {formatNumber(page.sessions.length)}개 표시
                {result.isFetching ? " · 최신 목록 확인 중" : ""}
              </p>
            </>
          ) : null}
          <SessionPageTable
            rows={page?.sessions ?? []}
            loading={result.isPending}
            busy={result.isFetching}
            onOpen={(row) => {
              if (
                !canOpen(row) ||
                !row.session_id ||
                containsPotentialSecret(row.session_id, auth.credentialPrefixes)
              )
                return;
              focus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              update({ session_id: row.session_id });
            }}
          />
          <nav className="session-page-pagination" aria-label="세션 페이지">
            <Button
              aria-disabled={previousDisabled}
              onClick={() => {
                if (!previousDisabled) update({ offset: undefined });
              }}
            >
              처음
            </Button>
            <Button
              aria-disabled={previousDisabled}
              onClick={() => {
                if (!previousDisabled) update({ offset: String(Math.max(0, query.offset - query.limit)) });
              }}
            >
              이전 세션
            </Button>
            <span>{query.offset / query.limit + 1}페이지</span>
            <Button
              aria-disabled={nextDisabled}
              onClick={() => {
                if (!nextDisabled) update({ offset: String(query.offset + query.limit) });
              }}
            >
              다음 세션
            </Button>
          </nav>
          {page &&
          page.summary.sessions > query.offset + query.limit &&
          query.offset + query.limit > 1_000_000 ? (
            <p>조회 가능한 페이지 범위를 넘었습니다. 기간이나 세션 ID로 검색 범위를 좁혀 주세요.</p>
          ) : null}
        </>
      )}
      <Sheet
        open={openSession !== ""}
        onOpenChange={(open) => {
          if (!open) update({ session_id: undefined });
        }}
        returnFocusRef={focus}
        size="wide"
        title="세션 비행기록"
        description="목록 기간과 별개인 세션의 제한된 최근 요청을 보여줍니다."
      >
        {openSession ? <FlightRecorderPanel sessionId={openSession} /> : null}
      </Sheet>
    </div>
  );
}
