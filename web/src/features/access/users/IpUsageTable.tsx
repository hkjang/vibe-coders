import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { DataTable, type DataTableSort } from "@/shared/data-table/DataTable";
import { DataTableSortControls } from "@/shared/data-table/DataTableSortControls";
import { createDataTableColumnHelper } from "@/shared/data-table/columns";
import { pageFromParam, useSearchState } from "@/shared/hooks/use-search-state";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { readIpSort, validIpText } from "./ip-usage-model";
import type { IpTableId } from "./ip-query-keys";
import { orderIpRows, type IpColumn } from "./ip-table-model";
export type { IpColumn } from "./ip-table-model";
const CellContext = createContext<(id: string, row: unknown) => ReactNode>(() => null);
function IpCell({ id, row }: { id: string; row: unknown }) {
  return useContext(CellContext)(id, row);
}
export function IpUsageTable<Row extends object>({
  id,
  caption,
  rows,
  columns,
  owner,
  loading = false,
  getRowId,
  onRowClick,
  getRowActionLabel,
}: {
  id: IpTableId;
  caption: string;
  rows: readonly Row[];
  columns: readonly IpColumn<Row>[];
  owner: FeatureReadOwner;
  loading?: boolean;
  getRowId?: (row: Row, index: number) => string;
  onRowClick?: (row: Row) => void;
  getRowActionLabel?: (row: Row) => string;
}) {
  const [params, update] = useSearchState();
  const { credentialPrefixes } = useAuth();
  const raw = params.get(id + "_q") ?? "";
  const query = validIpText(raw, credentialPrefixes) ? raw : "";
  const [input, setInput] = useState(query);
  const [previous, setPrevious] = useState(query);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  if (query !== previous) {
    setPrevious(query);
    setInput(query);
    setError("");
  }
  const sorts = readIpSort(
    params.get(id + "_sort"),
    columns.map((column) => column.id),
  );
  const sorted = orderIpRows(rows, columns, query, sorts);
  const sizes = [10, 25, 50];
  const size = sizes.find((size) => String(size) === params.get(id + "_size")) ?? 10;
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const page = Math.min(pageFromParam(params.get(id + "_page")) - 1, pages - 1);
  const descriptor = JSON.stringify(columns.map(({ id, header }) => ({ id, header })));
  const definitions = useMemo(() => {
    const helper = createDataTableColumnHelper<Row>();
    return (JSON.parse(descriptor) as { id: string; header: string }[]).map((column) =>
      helper.display({
        id: column.id,
        header: column.header,
        cell: ({ row }) => <IpCell id={column.id} row={row.original} />,
      }),
    );
  }, [descriptor]);
  const changeSort = (value: readonly DataTableSort[]) =>
    update({
      [id + "_sort"]: value.map((row) => `${row.columnId}:${row.direction}`).join(","),
      [id + "_page"]: undefined,
    });
  const rowAction:
    | { onRowClick: (row: Row) => void; getRowActionLabel: (row: Row) => string }
    | { onRowClick?: never; getRowActionLabel?: never } =
    onRowClick && getRowActionLabel ? { onRowClick, getRowActionLabel } : {};
  return (
    <div className="ip-usage-table">
      <form
        className="ip-usage-controls"
        aria-label={caption + " 검색"}
        onSubmit={(event) => {
          event.preventDefault();
          const next = input.trim();
          if (next && !validIpText(next, credentialPrefixes)) {
            setError("비밀값 없이 200자 이내로 입력하세요.");
            inputRef.current?.focus();
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
              ref={inputRef}
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
          disabled={loading || sorted.length === 0}
          onClick={() => {
            if (owner.isCurrent())
              downloadCsv(
                id + ".csv",
                toCsv(
                  sorted,
                  columns.map((column) => ({ header: column.header, value: column.value })),
                ),
              );
          }}
        >
          검색 결과 CSV
        </Button>
      </form>
      <div className="ip-usage-sort">
        <p className="access-note">
          받은 목록 {rows.length.toLocaleString("ko-KR")}건 중 {sorted.length.toLocaleString("ko-KR")}건 ·
          검색·정렬·CSV는 받은 목록에 적용됩니다.
        </p>
        <DataTableSortControls
          columns={columns.map((column) => ({ id: column.id, label: column.header }))}
          value={sorts}
          onChange={changeSort}
        />
      </div>
      {sorts.length ? (
        <p className="access-note">
          정렬 순서:{" "}
          {sorts
            .map(
              (sort) =>
                `${columns.find((column) => column.id === sort.columnId)?.header ?? ""} ${sort.direction === "asc" ? "오름차순" : "내림차순"}`,
            )
            .join(" → ")}
        </p>
      ) : null}
      <CellContext.Provider
        value={(id, row) => {
          const column = columns.find((column) => column.id === id);
          return column?.cell ? column.cell(row as Row) : (column?.value(row as Row) ?? "미확인");
        }}
      >
        <DataTable
          caption={caption}
          columns={definitions}
          data={sorted.slice(page * size, (page + 1) * size)}
          loading={loading}
          tableId={"access.users.ip_usage." + id}
          lockedColumnIds={columns[0] ? [columns[0].id] : []}
          getRowId={getRowId}
          {...rowAction}
          emptyMessage={query ? "검색 조건에 맞는 항목이 없습니다." : "기록된 항목이 없습니다."}
          pageCount={pages}
          pageIndex={page}
          onPageChange={(page) => update({ [id + "_page"]: page + 1 })}
          pageSizeControl={{
            value: size,
            options: sizes,
            onChange: (value) => update({ [id + "_size"]: value, [id + "_page"]: undefined }),
          }}
          sorting={{
            columns: columns.map(({ id }) => ({ id })),
            value: sorts[0],
            onChange: (value) => changeSort([value]),
          }}
        />
      </CellContext.Provider>
    </div>
  );
}
