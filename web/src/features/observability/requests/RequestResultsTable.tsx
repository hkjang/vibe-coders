import { useMemo } from "react";
import type { AppRequestSummary, AppRequestsResponse } from "@/shared/api/schemas";
import { RowSelectionCheckbox } from "@/shared/data-table/RowSelectionCheckbox";
import { usePageRowSelection } from "@/shared/data-table/use-page-row-selection";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { httpStatusTone } from "@/shared/utils/http-status";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { formatRequestDate } from "./request-date";
import { requestSelectionIdentity } from "./request-safe-flow-selection";
import { requestCsvColumns, requestCsvFilename } from "./request-csv";
import { RequestCost } from "./RequestCost";

const emptyRows: AppRequestSummary[] = [];
interface Props {
  data: AppRequestsResponse | undefined;
  frame: object;
  ready: boolean;
  fetching: boolean;
  isDataCurrent: () => boolean;
  timeZone: string;
  selecting: boolean;
  onSelecting: (value: boolean) => void;
  onCursor: (cursor?: string) => void;
  onOpen: (request: AppRequestSummary, ordinal: number) => void;
  onRowRef: (request: AppRequestSummary, node: HTMLButtonElement | null) => void;
}
export function RequestResultsTable({
  data,
  frame,
  ready,
  fetching,
  isDataCurrent,
  timeZone,
  selecting,
  onSelecting,
  onCursor,
  onOpen,
  onRowRef,
}: Props): React.JSX.Element {
  const rows = data?.requests ?? emptyRows;
  const selectionFrame = useMemo(() => ({ frame, selecting }), [frame, selecting]);
  const bulk = usePageRowSelection(selectionFrame, rows, requestSelectionIdentity, isDataCurrent);
  return (
    <div className="data-table-shell">
      <div className="request-selection-toolbar">
        <Button
          variant="secondary"
          size="small"
          disabled={!selecting && (!ready || !rows.length)}
          onClick={() => {
            if (selecting || isDataCurrent()) onSelecting(!selecting);
          }}
        >
          {selecting ? "선택 마치기" : "여러 요청 선택"}
        </Button>
        {selecting && (
          <>
            <span role="status">
              현재 페이지 {rows.length.toLocaleString("ko-KR")}건 중 {bulk.count.toLocaleString("ko-KR")}건
              선택
            </span>
            <Button variant="secondary" size="small" disabled={!ready || !bulk.count} onClick={bulk.clear}>
              선택 해제
            </Button>
            <Button
              variant="secondary"
              size="small"
              disabled={!ready || !bulk.count}
              onClick={() => {
                if (data && bulk.isCurrent() && bulk.count > 0)
                  downloadCsv(
                    requestCsvFilename(data.generated_at, true),
                    toCsv(bulk.selectedRows, requestCsvColumns),
                  );
              }}
            >
              선택한 요청 CSV
            </Button>
            <p className="request-selection-note">
              선택 중에는 자동 갱신하지 않습니다. 페이지·필터·새 응답이 바뀌면 선택이 해제됩니다.
            </p>
          </>
        )}
      </div>
      <div className="data-table-scroll" tabIndex={0} aria-label="요청 목록 표 영역">
        <table className="data-table request-table">
          <caption className="sr-only">현재 페이지 요청 목록</caption>
          <thead>
            <tr>
              {selecting && (
                <th className="request-selection-column" scope="col">
                  <RowSelectionCheckbox
                    label="현재 페이지 요청 전체 선택"
                    checked={bulk.all}
                    mixed={bulk.mixed}
                    disabled={!ready || rows.length === 0}
                    onChange={bulk.toggleAll}
                  />
                </th>
              )}
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
              data.requests.map((request, index) => (
                <tr
                  key={requestSelectionIdentity(request)}
                  data-selected={(selecting && bulk.has(request)) || undefined}
                >
                  {selecting && (
                    <td className="request-selection-column">
                      <RowSelectionCheckbox
                        label={`${index + 1}번째 요청 선택`}
                        checked={bulk.has(request)}
                        disabled={!ready}
                        onChange={() => bulk.toggle(request)}
                      />
                    </td>
                  )}
                  <td>
                    <time
                      data-testid={`request-created-at-${request.request_id}`}
                      dateTime={request.created_at}
                    >
                      {formatRequestDate(request.created_at, timeZone, {
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
                    <RequestCost value={request.estimated_cost} currency={request.currency} />
                  </td>
                  <td>
                    <Button
                      size="small"
                      variant="ghost"
                      ref={(node) => onRowRef(request, node)}
                      aria-disabled={!ready}
                      aria-label={`${index + 1}번째 요청 ${request.request_id} 상세 보기`}
                      onClick={() => onOpen(request, index + 1)}
                    >
                      상세
                    </Button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="data-table-state" colSpan={selecting ? 10 : 9}>
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
              {formatRequestDate(data.generated_at, timeZone, { timeStyle: "medium" })}
            </time>
          ) : (
            "-"
          )}
        </span>
        <Button
          variant="secondary"
          size="small"
          disabled={!ready || !data?.requests.length}
          onClick={() => {
            if (data && isDataCurrent())
              downloadCsv(requestCsvFilename(data.generated_at), toCsv(data.requests, requestCsvColumns));
          }}
        >
          현재 목록 CSV
        </Button>
        <Button
          variant="secondary"
          size="small"
          disabled={!data?.previous_cursor || fetching}
          onClick={() => {
            onCursor(data?.previous_cursor);
          }}
        >
          이전
        </Button>
        <Button
          variant="secondary"
          size="small"
          disabled={!data?.next_cursor || fetching}
          onClick={() => {
            onCursor(data?.next_cursor);
          }}
        >
          다음
        </Button>
      </div>
    </div>
  );
}
