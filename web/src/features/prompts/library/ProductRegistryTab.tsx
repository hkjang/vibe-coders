import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import type { PromptProductMetadataItem } from "@/shared/api/generated";
import { productStates } from "@/shared/api/domains/prompt-products";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { DataTable } from "@/shared/data-table/DataTable";
import type { DataTableColumn } from "@/shared/data-table/columns";
import { pageFromParam, useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { readProductMetadata } from "./product-registry-api";
import { productMessages as text } from "./product-registry-messages";
import { PanelFailure } from "./prompt-parts";
import { useLibraryQuery } from "./use-library-query";

const number = (value: number | null) => (value === null ? text.unknown : formatNumber(value));
const timestamp = (value: string | null, missing: string) =>
  value ? <time dateTime={value}>{formatDateTime(value)}</time> : missing;
const columns: readonly DataTableColumn<PromptProductMetadataItem>[] = [
  { id: "name", header: text.columns.name, size: 220, cell: ({ row }) => row.original.name },
  {
    id: "category",
    header: text.columns.category,
    size: 130,
    cell: ({ row }) => (row.original.category === "product" ? text.categoryDefault : row.original.category),
  },
  {
    id: "state",
    header: text.columns.state,
    size: 116,
    cell: ({ row }) => (
      <Badge
        tone={
          row.original.template_state === "enabled"
            ? "success"
            : row.original.template_state === "missing"
              ? "warning"
              : "muted"
        }
      >
        {text.states[row.original.template_state]}
      </Badge>
    ),
  },
  {
    id: "source",
    header: text.columns.source,
    size: 152,
    cell: ({ row }) => number(row.original.source_requests),
  },
  {
    id: "keys",
    header: text.columns.keys,
    size: 140,
    cell: ({ row }) => number(row.original.source_distinct_keys),
  },
  {
    id: "uses",
    header: text.columns.uses,
    size: 166,
    cell: ({ row }) =>
      row.original.template_state === "missing" ? text.missing : number(row.original.use_count),
  },
  {
    id: "last",
    header: text.columns.last,
    size: 180,
    cell: ({ row }) =>
      row.original.template_state === "missing"
        ? text.missing
        : timestamp(row.original.last_used_at, text.noHistory),
  },
  {
    id: "created",
    header: text.columns.created,
    size: 180,
    cell: ({ row }) => timestamp(row.original.created_at, text.unknown),
  },
];

export function ProductRegistryTab() {
  const { backendVersion } = useAuth();
  if (!versionAtLeast(backendVersion, "v0.86.131"))
    return (
      <InlineNotice tone="info" title={text.tab}>
        {text.support}
      </InlineNotice>
    );
  return <ProductRegistryContent />;
}

function ProductRegistryContent() {
  const [params, update] = useSearchState();
  const state = productStates.find((value) => value === params.get("products_state")) ?? "all";
  const size = [25, 50, 100].includes(Number(params.get("products_size")))
    ? Number(params.get("products_size"))
    : 25;
  const page = Math.min(pageFromParam(params.get("products_page")), Math.floor(1_000_000 / size) + 1);
  const offset = (page - 1) * size;
  const query = useLibraryQuery({
    key: ["prompts", "products", state, size, offset],
    read: (prefixes, signal) =>
      readProductMetadata({ view: "metadata", state, limit: size, offset }, prefixes, signal),
  });
  const data = query.data;
  const pageCount = Math.min(Math.ceil((data?.total ?? 0) / size), Math.floor(1_000_000 / size) + 1);
  return (
    <div className="page-stack">
      <InlineNotice tone="info" title={text.readOnly}>
        {text.content}
      </InlineNotice>
      <SectionCard
        title={text.tab}
        description={text.scope}
        actions={
          <label className="toolbar">
            <span>{text.state}</span>
            <Select
              aria-label={text.state}
              value={state}
              onChange={(event) =>
                update({ products_state: event.target.value, products_page: null }, { replace: false })
              }
            >
              {productStates.map((value) => (
                <option value={value} key={value}>
                  {text.states[value]}
                </option>
              ))}
            </Select>
          </label>
        }
      >
        {query.isError ? (
          <PanelFailure
            label={text.tab}
            error={query.error}
            hasData={Boolean(data)}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {data ? (
          <p role="status">
            조건에 맞는 제품 {formatNumber(data.total)}개 · 현재 페이지 {formatNumber(data.items.length)}개 ·
            마지막 정상 조회 {formatDateTime(data.generated_at)}
          </p>
        ) : null}
        <DataTable
          tableId="prompt-products"
          lockedColumnIds={["name", "state"]}
          caption={text.caption}
          columns={columns}
          data={data?.items ?? []}
          loading={query.isPending}
          error={query.isError && !data ? text.failed : undefined}
          onRetry={() => void query.refetch()}
          pageCount={data?.items.length === 0 ? 1 : Math.max(1, pageCount)}
          pageIndex={page - 1}
          onPageChange={(index) => update({ products_page: index + 1 }, { replace: false })}
          emptyMessage={page > 1 ? text.pageEmpty : text.empty}
          pageSizeControl={{
            value: size,
            options: [25, 50, 100],
            onChange: (value) => update({ products_size: value, products_page: null }, { replace: false }),
          }}
        />
        {data && data.items.length === 0 && page > 1 ? (
          <Button onClick={() => update({ products_page: null }, { replace: false })}>
            {text.firstPage}
          </Button>
        ) : null}
        <p className="muted">{text.help}</p>
        <p className="muted">{text.missingHelp}</p>
      </SectionCard>
    </div>
  );
}
