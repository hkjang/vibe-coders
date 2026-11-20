import { DataTableHeaderContent } from "@/shared/data-table/DataTableColumnHelp";
import { TableStateCell } from "@/shared/data-table/TableStateCell";
import { useMemo, useRef, useState } from "react";
import { Columns3, MoveHorizontal } from "lucide-react";
import type { AppRequestSummary, AppRequestsResponse } from "@/shared/api/schemas";
import { RowSelectionCheckbox } from "@/shared/data-table/RowSelectionCheckbox";
import { usePageRowSelection } from "@/shared/data-table/use-page-row-selection";
import { DataTableResizeHandle } from "@/shared/data-table/DataTableResizeHandle";
import { DataTableSettingsLoader } from "@/shared/data-table/DataTableSettingsLoader";
import {
  useDataTableLayout,
  useDataTableOverflow,
  dataTableColumnLabel,
} from "@/shared/data-table/use-data-table-layout";
import { Button } from "@/shared/components/ui/Button";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { formatRequestDate } from "./request-date";
import { requestSelectionIdentity } from "./request-safe-flow-selection";
import { requestCsvColumns, requestCsvFilename } from "./request-csv";
import { requestLockedColumns, requestTableColumns, requestTableId } from "./request-table-columns";

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
  const columns = useMemo(() => requestTableColumns(timeZone), [timeZone]);
  const layout = useDataTableLayout({
    columns,
    data: rows,
    getRowId: requestSelectionIdentity,
    lockedColumnIds: requestLockedColumns,
    tableId: requestTableId,
  });
  const { table } = layout;
  const { scrollRef, scrollState, updateScrollState } = useDataTableOverflow(
    rows,
    fetching,
    `${layout.layoutVersion}:${selecting}`,
  );
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const width = table.getTotalSize() + 88 + (selecting ? 48 : 0);

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
        <Button ref={settingsTrigger} variant="secondary" size="small" onClick={() => setSettingsOpen(true)}>
          <Columns3 aria-hidden="true" /> 열 설정
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
      <div
        className="data-table-scroll-frame"
        data-at-start={scrollState.atStart || undefined}
        data-at-end={scrollState.atEnd || undefined}
        data-overflow={scrollState.overflowing || undefined}
      >
        <div
          ref={scrollRef}
          className="data-table-scroll"
          tabIndex={0}
          aria-label="요청 목록 표 영역"
          onScroll={updateScrollState}
        >
          <table
            className="data-table request-table"
            style={{ minWidth: width, width, tableLayout: "fixed" }}
          >
            <caption className="sr-only">현재 페이지 요청 목록</caption>
            <thead>
              <tr>
                {selecting && (
                  <th className="request-selection-column" scope="col" style={{ width: 48 }}>
                    <RowSelectionCheckbox
                      label="현재 페이지 요청 전체 선택"
                      checked={bulk.all}
                      mixed={bulk.mixed}
                      disabled={!ready || rows.length === 0}
                      onChange={bulk.toggleAll}
                    />
                  </th>
                )}
                {table.getHeaderGroups()[0]?.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    className="data-table-resizable-heading"
                    style={{ width: header.getSize() }}
                  >
                    <DataTableHeaderContent
                      label={dataTableColumnLabel(header.column)}
                      help={header.column.columnDef.meta?.help}
                    >
                      <table.FlexRender header={header} />
                    </DataTableHeaderContent>
                    <DataTableResizeHandle
                      label={dataTableColumnLabel(header.column)}
                      width={header.getSize()}
                      onReset={() => header.column.resetSize()}
                      onKey={(key) => layout.resizeColumnByKey(header.column.id, header.getSize(), key)}
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                    />
                  </th>
                ))}
                <th scope="col" style={{ width: 88 }}>
                  <span className="sr-only">작업</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                table.getRowModel().rows.map((row, index) => {
                  const request = row.original;
                  return (
                    <tr
                      key={requestSelectionIdentity(request)}
                      data-selected={(selecting && bulk.has(request)) || undefined}
                    >
                      {selecting && (
                        <td className="request-selection-column" style={{ width: 48 }}>
                          <RowSelectionCheckbox
                            label={`${index + 1}번째 요청 선택`}
                            checked={bulk.has(request)}
                            disabled={!ready}
                            onChange={() => bulk.toggle(request)}
                          />
                        </td>
                      )}
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} style={{ width: cell.column.getSize() }}>
                          <div className="data-table-cell-content">
                            <table.FlexRender cell={cell} />
                          </div>
                        </td>
                      ))}
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
                  );
                })
              ) : (
                <tr>
                  <TableStateCell colSpan={layout.visibleColumnCount + (selecting ? 2 : 1)}>
                    조건에 맞는 요청이 없습니다. 기간이나 필터를 조정해 보세요.
                  </TableStateCell>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {scrollState.overflowing && (
        <div className="data-table-overflow-hint" aria-hidden="true">
          <MoveHorizontal /> 좌우로 이동해 추가 열 보기
        </div>
      )}
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
      {settingsOpen && (
        <DataTableSettingsLoader
          announcement={layout.settingsAnnouncement}
          columns={layout.settingsColumns}
          description="표시할 열과 순서를 정합니다. 머리글 경계에서 마우스·키보드로 너비를 조절할 수 있습니다. 열 설정은 화면에만 적용되며 CSV는 전체 운영 항목을 포함합니다."
          onMove={layout.moveColumn}
          onOpenChange={setSettingsOpen}
          onReset={layout.resetSettings}
          onToggleVisibility={layout.toggleColumnVisibility}
          open={settingsOpen}
          returnFocusRef={settingsTrigger}
        />
      )}
    </div>
  );
}
