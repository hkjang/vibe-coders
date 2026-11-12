import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { DataTable } from "@/shared/data-table/DataTable";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { pageFromParam, useSearchState } from "@/shared/hooks/use-search-state";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { useMeOwner } from "./me-console-context";
import { validMeText } from "./me-console-model";
import type { MeTableId } from "./me-query-keys";

export interface MeColumn<Row extends object> {
  id: string;
  header: string;
  value?: (row: Row) => string | number | undefined;
  cell?: (row: Row) => ReactNode;
}
const CellContext = createContext<(id: string, row: unknown) => ReactNode>(() => null);
function MeCell({ id, row }: { id: string; row: unknown }) {
  return useContext(CellContext)(id, row);
}
export function MeTable<Row extends object>({
  id,
  caption,
  rows,
  columns,
  getRowId,
  description,
  loading = false,
  onRowClick,
  getRowActionLabel,
}: {
  id: MeTableId;
  caption: string;
  rows: readonly Row[];
  columns: readonly MeColumn<Row>[];
  getRowId?: (row: Row, index: number) => string;
  description?: string;
  loading?: boolean;
  onRowClick?: (row: Row) => void;
  getRowActionLabel?: (row: Row) => string;
}) {
  const [params, update] = useSearchState();
  const { credentialPrefixes } = useAuth();
  const owner = useMeOwner();
  const rawQuery = params.get(id + "_q") ?? "";
  const query = validMeText(rawQuery, credentialPrefixes, 200) ? rawQuery : "";
  const [input, setInput] = useState(query);
  const [error, setError] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [previousQuery, setPreviousQuery] = useState(query);
  if (previousQuery !== query) {
    setPreviousQuery(query);
    setInput(query);
    setError("");
  }
  const sizes = [10, 25, 50];
  const size = sizes.find((value) => value === Number(params.get(id + "_size"))) ?? 10;
  const sort = columns.find((column) => column.id === params.get(id + "_sort") && column.value);
  const direction = params.get(id + "_direction") === "desc" ? "desc" : "asc";
  const ordered = useMemo(() => {
    const filtered = query
      ? rows.filter((row) =>
          columns.some((column) =>
            String(column.value?.(row) ?? "")
              .toLocaleLowerCase("ko")
              .includes(query.toLocaleLowerCase("ko")),
          ),
        )
      : rows;
    if (!sort?.value) return filtered;
    const value = sort.value;
    return [...filtered].sort((a, b) => {
      const left = value(a),
        right = value(b);
      if (left === undefined) return right === undefined ? 0 : 1;
      if (right === undefined) return -1;
      const result =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right), "ko", { numeric: true });
      return direction === "desc" ? -result : result;
    });
  }, [rows, columns, query, sort, direction]);
  const pages = Math.max(1, Math.ceil(ordered.length / size));
  const page = Math.min(pageFromParam(params.get(id + "_page")) - 1, pages - 1);
  const pageRows = useMemo(() => ordered.slice(page * size, (page + 1) * size), [ordered, page, size]);
  const descriptor = JSON.stringify(columns.map(({ id, header }) => ({ id, header })));
  const rowAction:
    | { onRowClick: (row: Row) => void; getRowActionLabel: (row: Row) => string }
    | { onRowClick?: never; getRowActionLabel?: never } =
    onRowClick && getRowActionLabel ? { onRowClick, getRowActionLabel } : {};
  const definitions = useMemo<readonly DataTableColumn<Row>[]>(() => {
    const helper = createDataTableColumnHelper<Row>();
    return (JSON.parse(descriptor) as { id: string; header: string }[]).map((column) =>
      helper.display({
        id: column.id,
        header: column.header,
        cell: ({ row }) => <MeCell id={column.id} row={row.original} />,
      }),
    );
  }, [descriptor]);
  return (
    <div className="me-table">
      <form
        className="me-table-controls"
        aria-label={caption + " 검색"}
        onSubmit={(event) => {
          event.preventDefault();
          const next = input.trim();
          if (next && !validMeText(next, credentialPrefixes, 200)) {
            setError("검색어는 비밀값 없이 200자 이내로 입력하세요.");
            searchInput.current?.focus();
            return;
          }
          setError("");
          update({ [id + "_q"]: next, [id + "_page"]: undefined });
        }}
      >
        <FormField label={caption + " 검색어"} error={error}>
          {(control) => (
            <Input
              {...control}
              ref={searchInput}
              value={input}
              maxLength={200}
              onChange={(event) => setInput(event.target.value)}
            />
          )}
        </FormField>
        <Button type="submit" disabled={loading}>
          검색
        </Button>
        {query ? (
          <Button
            type="button"
            onClick={() => {
              setInput("");
              setError("");
              update({ [id + "_q"]: undefined, [id + "_page"]: undefined });
            }}
          >
            검색 초기화
          </Button>
        ) : null}
        <Button
          type="button"
          disabled={loading || ordered.length === 0}
          onClick={() => {
            if (owner.isCurrent())
              downloadCsv(
                "me-" + id + ".csv",
                toCsv(
                  ordered,
                  columns
                    .filter((column) => column.value)
                    .map((column) => ({ header: column.header, value: (row: Row) => column.value?.(row) })),
                ),
              );
          }}
        >
          검색 결과 CSV
        </Button>
      </form>
      <p className="me-table-summary">
        {description} 받은 목록 {rows.length.toLocaleString("ko-KR")}건 중{" "}
        {ordered.length.toLocaleString("ko-KR")}건 표시 · 검색·정렬·내보내기는 받은 목록에 적용됩니다.
      </p>
      <CellContext.Provider
        value={(id, row) => {
          const column = columns.find((item) => item.id === id);
          return column?.cell ? column.cell(row as Row) : (column?.value?.(row as Row) ?? "—");
        }}
      >
        <DataTable
          caption={caption}
          {...rowAction}
          columns={definitions}
          data={pageRows}
          tableId={"me.home." + id}
          getRowId={getRowId}
          lockedColumnIds={columns[0] ? [columns[0].id] : []}
          loading={loading}
          emptyMessage={query ? "검색 조건에 맞는 항목이 없습니다." : "아직 기록된 항목이 없습니다."}
          pageCount={pages}
          pageIndex={page}
          onPageChange={(value) => update({ [id + "_page"]: value + 1 })}
          pageSizeControl={{
            value: size,
            options: sizes,
            onChange: (value) => update({ [id + "_size"]: value, [id + "_page"]: undefined }),
          }}
          sorting={{
            columns: columns.filter((column) => column.value).map(({ id }) => ({ id })),
            value: sort ? { columnId: sort.id, direction } : undefined,
            onChange: (value) =>
              update({
                [id + "_sort"]: value.columnId,
                [id + "_direction"]: value.direction,
                [id + "_page"]: undefined,
              }),
          }}
        />
      </CellContext.Provider>
    </div>
  );
}
