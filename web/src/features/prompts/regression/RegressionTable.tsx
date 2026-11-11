import type { ReactNode } from "react";
import { Link } from "react-router";
import { Badge } from "@/shared/components/ui/Badge";
import { DataTable } from "@/shared/data-table/DataTable";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { formatDateTime, formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";
import type { GoldenResult } from "@/shared/api/domains/golden";
import type { RegressionTab } from "./regression-model";

export interface RegressionRow {
  id: string;
  name: string;
  tags: readonly string[];
  time: string;
  steps?: number | null;
  result?: GoldenResult;
}
interface DisplayRow extends RegressionRow {
  target?: string;
  open: (id: string) => void;
  captureFocus: (element: HTMLElement) => void;
}
const helper = createDataTableColumnHelper<DisplayRow>();

// Keep cell component identities stable when polling replaces the row values.
function createColumns(tab: RegressionTab): DataTableColumn<DisplayRow>[] {
  const column = (id: string, header: string, render: (row: DisplayRow) => ReactNode) =>
    helper.display({ id, header, cell: ({ row }) => render(row.original) });
  return [
    column("name", tab === "results" ? "프롬프트 / 모델" : "이름", (row) => {
      const target = row.target;
      return (
        <div className="regression-cell">
          {target ? (
            <Link
              to={target}
              onClick={(event) => {
                if (
                  event.button === 0 &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.shiftKey &&
                  !event.altKey
                )
                  row.captureFocus(event.currentTarget);
              }}
            >
              {row.name || "이름 없음"}
            </Link>
          ) : (
            <button
              className="button button-ghost button-small"
              onClick={(event) => {
                row.captureFocus(event.currentTarget);
                row.open(row.id);
              }}
            >
              {row.name || "이름 없음"}
            </button>
          )}
          {row.result ? <span className="muted">{row.result.model || "모델 미기록"}</span> : null}
        </div>
      );
    }),
    ...(tab === "results"
      ? [
          column("passed", "검사 결과", (row) =>
            row.result ? (
              <Badge tone={row.result.passed ? "success" : "danger"}>
                {row.result.passed ? "통과" : "미통과"}
              </Badge>
            ) : (
              "—"
            ),
          ),
          column("score", "일치 점수 (0–1)", (row) => formatNumber(row.result?.score, 2)),
          column("cost", "비용 (원)", (row) => formatKRW(row.result?.cost_krw)),
          column("latency", "지연", (row) => formatDuration(row.result?.latency_ms)),
        ]
      : [
          column("tags", "태그", (row) => (row.tags.length ? row.tags.join(", ") : "—")),
          ...(tab === "workflows"
            ? [
                column("steps", "검증 단계", (row) =>
                  row.steps === null ? "확인 불가" : formatNumber(row.steps),
                ),
              ]
            : []),
        ]),
    column("time", tab === "results" ? "실행 시각" : "수정 시각", (row) => formatDateTime(row.time)),
  ];
}

const columnsByTab = {
  prompts: createColumns("prompts"),
  workflows: createColumns("workflows"),
  results: createColumns("results"),
};

export function RegressionTable({
  rows,
  tab,
  page,
  setPage,
  loading,
  failed,
  retry,
  open,
  href,
  captureFocus,
}: {
  rows: readonly RegressionRow[];
  tab: RegressionTab;
  page: number;
  setPage: (page: number) => void;
  loading: boolean;
  failed: boolean;
  retry: () => void;
  open: (id: string) => void;
  href: (id: string) => string | undefined;
  captureFocus: (element: HTMLElement) => void;
}) {
  const pages = Math.max(1, Math.ceil(rows.length / 25));
  const current = Math.min(Math.max(page, 1), pages);
  return (
    <DataTable
      caption={
        tab === "prompts"
          ? "기준 프롬프트 목록"
          : tab === "workflows"
            ? "검증 워크플로 목록"
            : "최근 실행 결과 목록"
      }
      columns={columnsByTab[tab]}
      data={rows.slice((current - 1) * 25, current * 25).map((row) => ({
        ...row,
        target: href(row.id),
        open,
        captureFocus,
      }))}
      tableId={`golden-regression-${tab}`}
      lockedColumnIds={["name"]}
      getRowId={(row) => row.id}
      pageCount={pages}
      pageIndex={current - 1}
      onPageChange={(next) => setPage(next + 1)}
      loading={loading}
      error={failed ? "목록을 조회하지 못했습니다." : undefined}
      onRetry={retry}
      emptyMessage="현재 조건에 맞는 데이터가 없습니다."
      getRowActionLabel={(row) => `${row.name || "이름 없는 항목"} 상세 보기`}
      onRowClick={(row) => {
        if (document.activeElement instanceof HTMLElement) captureFocus(document.activeElement);
        open(row.id);
      }}
    />
  );
}
