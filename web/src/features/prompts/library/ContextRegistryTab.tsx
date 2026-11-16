import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import type { ContextRegistryMetadataItem } from "@/shared/api/generated";
import { contextStates } from "@/shared/api/domains/context-registry";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { DataTable } from "@/shared/data-table/DataTable";
import type { DataTableColumn } from "@/shared/data-table/columns";
import { pageFromParam, useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { readContextMetadata } from "./context-registry-api";
import { contextMessages as text } from "./context-registry-messages";
import { PanelFailure } from "./prompt-parts";
import { useLibraryQuery } from "./use-library-query";

const number = (value: number | null) => (value === null ? text.unknown : formatNumber(value));
const timestamp = (value: string | null, missing: string) =>
  value ? <time dateTime={value}>{formatDateTime(value)}</time> : missing;
const columns: readonly DataTableColumn<ContextRegistryMetadataItem>[] = [
  { id: "name", header: text.columns.name, size: 210, cell: ({ row }) => row.original.name },
  { id: "key", header: text.columns.key, size: 170, cell: ({ row }) => <code>{row.original.key}</code> },
  {
    id: "enabled",
    header: text.columns.enabled,
    size: 116,
    cell: ({ row }) => (
      <Badge tone={row.original.enabled ? "success" : "muted"}>
        {row.original.enabled ? text.states.enabled : text.states.disabled}
      </Badge>
    ),
  },
  {
    id: "tokens",
    header: text.columns.tokens,
    size: 100,
    cell: ({ row }) => number(row.original.token_estimate),
  },
  { id: "count", header: text.columns.count, size: 132, cell: ({ row }) => number(row.original.use_count) },
  {
    id: "last",
    header: text.columns.last,
    size: 180,
    cell: ({ row }) => timestamp(row.original.last_used_at, text.noHistory),
  },
  {
    id: "updated",
    header: text.columns.updated,
    size: 180,
    cell: ({ row }) => timestamp(row.original.updated_at, text.unknown),
  },
];

export function ContextRegistryTab() {
  const { backendVersion } = useAuth();
  if (!versionAtLeast(backendVersion, "v0.86.130"))
    return (
      <InlineNotice tone="info" title={text.tab}>
        {text.support}
      </InlineNotice>
    );
  return <ContextRegistryContent />;
}

function ContextRegistryContent() {
  const [params, update] = useSearchState();
  const state = contextStates.find((value) => value === params.get("contexts_state")) ?? "all";
  const size = [25, 50, 100].includes(Number(params.get("contexts_size")))
    ? Number(params.get("contexts_size"))
    : 25;
  const page = Math.min(pageFromParam(params.get("contexts_page")), Math.floor(1_000_000 / size) + 1);
  const offset = (page - 1) * size;
  const query = useLibraryQuery({
    key: ["prompts", "contexts", state, size, offset],
    read: (prefixes, signal) =>
      readContextMetadata({ view: "metadata", state, limit: size, offset }, prefixes, signal),
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
                update({ contexts_state: event.target.value, contexts_page: null }, { replace: false })
              }
            >
              {contextStates.map((value) => (
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
            조건에 맞는 자료 {formatNumber(data.total)}개 · 현재 페이지 {formatNumber(data.items.length)}개 ·
            마지막 정상 조회 {formatDateTime(data.generated_at)}
          </p>
        ) : null}
        <DataTable
          tableId="prompt-contexts"
          lockedColumnIds={["name", "key"]}
          caption={text.caption}
          columns={columns}
          data={data?.items ?? []}
          loading={query.isPending}
          error={query.isError && !data ? text.failed : undefined}
          onRetry={() => void query.refetch()}
          pageCount={data?.items.length === 0 ? 1 : Math.max(1, pageCount)}
          pageIndex={page - 1}
          onPageChange={(index) => update({ contexts_page: index + 1 }, { replace: false })}
          emptyMessage={page > 1 ? text.pageEmpty : text.empty}
          pageSizeControl={{
            value: size,
            options: [25, 50, 100],
            onChange: (value) => update({ contexts_size: value, contexts_page: null }, { replace: false }),
          }}
        />
        {data && data.items.length === 0 && page > 1 ? (
          <Button onClick={() => update({ contexts_page: null }, { replace: false })}>
            {text.firstPage}
          </Button>
        ) : null}
        <p className="muted">{text.help}</p>
      </SectionCard>
    </div>
  );
}
