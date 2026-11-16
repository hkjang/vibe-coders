import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { DataTable, type DataTableSort } from "@/shared/data-table/DataTable";
import type { DataTableColumn } from "@/shared/data-table/columns";
import { formatNumber } from "@/shared/utils/format";

export interface UsageColumn<T> {
  id: string;
  title: string;
  value: (row: T) => string | number;
  cell?: (row: T) => ReactNode;
  numeric?: boolean;
}

const normalize = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase("ko-KR");
const collator = new Intl.Collator("ko-KR", { numeric: true, sensitivity: "base" });

/** Search and order only the bounded response. Never persist row data or search text. */
export function OverviewUsageTable<T extends object>({
  title,
  caption,
  description,
  searchLabel,
  rows,
  columns,
  identity,
  searchText,
  emptyTitle,
  emptyDescription,
}: {
  title: string;
  caption: string;
  description: string;
  searchLabel: string;
  rows: readonly T[];
  columns: readonly UsageColumn<T>[];
  identity: (row: T) => string;
  searchText: (row: T) => string;
  emptyTitle: string;
  emptyDescription: string;
}): React.JSX.Element {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<DataTableSort>({ columnId: "requests", direction: "desc" });
  const query = normalize(search);
  const visible = useMemo(() => {
    const column = columns.find((item) => item.id === sort.columnId);
    const result = rows.filter((row) => normalize(searchText(row)).includes(query));
    if (column) {
      result.sort((left, right) => {
        const a = column.value(left),
          b = column.value(right);
        const compared =
          typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
        return (
          (sort.direction === "asc" ? compared : -compared) ||
          collator.compare(identity(left), identity(right))
        );
      });
    }
    return result;
  }, [rows, columns, sort, query, searchText, identity]);
  const tableColumns: DataTableColumn<T>[] = columns.map((column) => ({
    id: column.id,
    header: column.title,
    accessorFn: column.value,
    cell: ({ row }) => (
      <span className={column.numeric ? "cell-number" : undefined}>
        {column.cell ? column.cell(row.original) : column.value(row.original)}
      </span>
    ),
  }));

  return (
    <SectionCard
      title={title}
      description={description}
      aria-label={title}
      className="overview-usage-section"
    >
      {rows.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <>
          <div className="overview-usage-tools">
            <div className="overview-usage-search">
              <label htmlFor={id}>{searchLabel}</label>
              <Input
                id={id}
                ref={input}
                type="search"
                maxLength={120}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-describedby={`${id}-scope`}
              />
            </div>
            <Button
              variant="secondary"
              disabled={search.length === 0}
              onClick={() => {
                setSearch("");
                input.current?.focus();
              }}
            >
              검색 지우기
            </Button>
            <p id={`${id}-scope`} aria-live="polite">
              수신 {formatNumber(rows.length)}개 중 {formatNumber(visible.length)}개 표시
            </p>
          </div>
          <DataTable
            caption={caption}
            columns={tableColumns}
            data={visible}
            getRowId={identity}
            emptyMessage="검색과 일치하는 항목이 없습니다. 검색어를 바꾸거나 지워 보세요."
            sorting={{
              value: sort,
              onChange: setSort,
              columns: columns.map((column) => ({
                id: column.id,
                initialDirection: column.numeric ? "desc" : "asc",
                sortLabel: column.title,
              })),
            }}
          />
        </>
      )}
    </SectionCard>
  );
}
