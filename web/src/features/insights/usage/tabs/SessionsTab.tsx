import { useMemo } from "react";

import { workStatuses, type WorkRequest } from "@/shared/api/domains/insights-common";
import type { WorkSessionRow } from "@/shared/api/domains/insights-usage";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { DataTable } from "@/shared/data-table/DataTable";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatNumber } from "@/shared/utils/format";

import { requestColumns, sessionColumns } from "../session-columns";
import {
  confidenceBands,
  listKinds,
  listLabels,
  pageCount,
  pageSize,
  readListState,
  requestsQuery,
  sessionSortColumns,
  sessionsQuery,
  writeSessionSort,
} from "../session-list-model";
import { useRequests, useSessions, type UsageRead } from "../use-usage-queries";
import { isUnavailable } from "../usage-errors";
import { classificationLabel, completionLabel, completionValues } from "../usage-labels";
import type { UsageTabProps } from "../usage-tab-props";

/** The message a list shows in place of its rows when its read failed with nothing to keep. */
function listError(query: UsageRead<unknown>, label: string): string | undefined {
  if (!query.isError || query.data !== undefined) return undefined;
  return isUnavailable(query.error)
    ? `${label}: 이 서버에서 아직 제공하지 않습니다.`
    : safeAppErrorMessage(query.error, `${label}을 불러오지 못했습니다.`);
}

interface SessionsTabProps extends UsageTabProps {
  onOpenSession: (sessionId: string) => void;
}

export function SessionsTab({ query, minGroupSize, onOpenSession }: SessionsTabProps): React.JSX.Element {
  const [params, update] = useSearchState();
  const state = readListState(params);
  const showSessions = state.kind === "sessions";

  const sessions = useSessions(sessionsQuery(query, state), showSessions);
  const requests = useRequests(requestsQuery(query, state), !showSessions);
  const sessionCols = useMemo(() => sessionColumns(), []);
  const requestCols = useMemo(() => requestColumns(), []);

  const total = showSessions ? sessions.data?.count : requests.data?.count;
  const pages = pageCount(total, state.page);
  const first = state.page * pageSize + 1;
  const shown = showSessions ? (sessions.data?.rows.length ?? 0) : (requests.data?.rows.length ?? 0);
  const goPage = (page: number): void =>
    update({ page: page === 0 ? undefined : page + 1 }, { replace: false });

  return (
    <SectionCard
      title="세션·요청"
      description="업무 세션과 분류된 요청을 한 건씩 봅니다. 세션을 열면 업무 구간과 요청이, 요청에서는 요청 탐색기로 가는 링크가 있습니다."
      actions={
        <div className="range-picker" role="group" aria-label="목록 종류">
          {listKinds.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={state.kind === kind}
              onClick={() =>
                update(
                  {
                    list: kind === "sessions" ? undefined : kind,
                    page: undefined,
                    sort: undefined,
                    status: undefined,
                    conf: undefined,
                    session_status: undefined,
                  },
                  { replace: false },
                )
              }
            >
              {listLabels[kind]}
            </button>
          ))}
        </div>
      }
    >
      <div className="wi-list-filters" role="group" aria-label={`${listLabels[state.kind]} 목록 필터`}>
        {showSessions ? (
          <label className="wi-filter" htmlFor="wi-session-status">
            <span>세션 완료 상태</span>
            <Select
              id="wi-session-status"
              value={state.completion}
              onChange={(event) => update({ session_status: event.target.value, page: undefined })}
              placeholder="전체"
              options={completionValues.map((value) => ({ value, label: completionLabel(value) }))}
            />
          </label>
        ) : (
          <>
            <label className="wi-filter" htmlFor="wi-class-status">
              <span>분류 상태</span>
              <Select
                id="wi-class-status"
                value={state.status}
                onChange={(event) => update({ status: event.target.value, page: undefined })}
                placeholder="전체"
                options={workStatuses.map((value) => ({ value, label: classificationLabel(value) }))}
              />
            </label>
            <label className="wi-filter" htmlFor="wi-confidence">
              <span>신뢰도</span>
              <Select
                id="wi-confidence"
                value={state.confidence}
                onChange={(event) => update({ conf: event.target.value, page: undefined })}
                placeholder="전체"
                options={confidenceBands.map((band) => ({ value: band.id, label: band.label }))}
              />
            </label>
          </>
        )}
        <p className="wi-list-count" role="status">
          {total === undefined
            ? "건수 확인 중"
            : total === 0
              ? "0건"
              : `전체 ${formatNumber(total)}건 중 ${formatNumber(first)}–${formatNumber(first + Math.max(0, shown - 1))}`}
        </p>
      </div>

      {total !== undefined && total > 0 && shown === 0 && state.page > 0 ? (
        <p className="wi-note" role="status">
          이 페이지에는 항목이 없습니다.{" "}
          <Button size="small" onClick={() => goPage(Math.max(0, Math.ceil(total / pageSize) - 1))}>
            마지막 페이지로 이동
          </Button>
        </p>
      ) : null}

      {showSessions ? (
        <div
          aria-busy={sessions.isFetching || undefined}
          data-previous={sessions.isPrevious || undefined}
          className="wi-panel"
        >
          <DataTable<WorkSessionRow>
            caption="업무 세션 목록"
            columns={sessionCols}
            data={sessions.data?.rows ?? []}
            getRowId={(row) => row.session_id}
            loading={sessions.isPending}
            error={listError(sessions, "업무 세션")}
            onRetry={sessions.refetch}
            emptyMessage="선택한 기간과 필터에 해당하는 업무 세션이 없습니다."
            pageCount={pages}
            pageIndex={state.page}
            onPageChange={goPage}
            sorting={{
              columns: sessionSortColumns.map((column) => ({
                id: column.id,
                initialDirection: column.initialDirection,
                sortLabel: column.label,
              })),
              value: state.sort,
              onChange: (sort) =>
                update({ sort: writeSessionSort(sort), page: undefined }, { replace: false }),
            }}
            getRowActionLabel={(row) => `세션 ${row.session_id} 상세 열기`}
            onRowClick={(row) => onOpenSession(row.session_id)}
          />
        </div>
      ) : (
        <div
          aria-busy={requests.isFetching || undefined}
          data-previous={requests.isPrevious || undefined}
          className="wi-panel"
        >
          <DataTable<WorkRequest>
            caption="분류된 요청 목록"
            columns={requestCols}
            data={requests.data?.rows ?? []}
            getRowId={(row) => row.request_id}
            loading={requests.isPending}
            error={listError(requests, "요청 목록")}
            onRetry={requests.refetch}
            emptyMessage="선택한 기간과 필터에 해당하는 요청이 없습니다."
            pageCount={pages}
            pageIndex={state.page}
            onPageChange={goPage}
            getRowActionLabel={(row) => `요청 ${row.request_id}의 세션 열기`}
            onRowClick={(row) => {
              if (row.session_id) onOpenSession(row.session_id);
            }}
          />
        </div>
      )}
      <p className="wi-note">
        사용자 값은 서버가 내려준 그대로 표시합니다. 원문 열람 권한이 없으면 서버가 식별자를 가명으로 바꾸거나
        비워 보내며(빈 값은 ‘—’), 이 화면은 가려진 값을 되살리지 않습니다. 이때 프롬프트에서 뽑은 작업 제목도
        내려오지 않아 업무 이름을 흐리게 대신 표시합니다. 활성 사용자가 {formatNumber(minGroupSize)}명 미만인
        집계는 다른 탭에서도 가립니다.
      </p>
    </SectionCard>
  );
}
