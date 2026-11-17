import { createContext, useContext, useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import { promptStages, stageWindows } from "@/shared/api/domains/prompt-stages";
import type { PromptStageWorkspaceItem } from "@/shared/api/generated";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Select } from "@/shared/components/ui/Select";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { DataTable } from "@/shared/data-table/DataTable";
import type { DataTableColumn } from "@/shared/data-table/columns";
import { pageFromParam, useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { readPromptStages } from "./stage-api";
import { stageMessages as text } from "./stage-messages";
import { PromptStageDialog } from "./PromptStageDialog";
import { useLibraryAccess, useLibraryBusy } from "./use-library-mutation";
import { useLibraryQuery } from "./use-library-query";
import { PanelFailure } from "./prompt-parts";

const StageActionContext = createContext<{
  blocked: boolean;
  reason?: string;
  open: (row: PromptStageWorkspaceItem, trigger: HTMLElement) => void;
}>({ blocked: true, open: () => undefined });
function StageAction({ row }: { row: PromptStageWorkspaceItem }) {
  const action = useContext(StageActionContext);
  return (
    <Button
      disabled={action.blocked || !row.can_change}
      title={!row.can_change ? text.locked : action.reason}
      onClick={(event) => action.open(row, event.currentTarget)}
    >
      {text.change}
    </Button>
  );
}

const columns: readonly DataTableColumn<PromptStageWorkspaceItem>[] = [
  {
    id: "name",
    header: text.columns.name,
    size: 220,
    cell: ({ row }) => (
      <div className="prompt-stage-entry">
        <span>{row.original.name}</span>
        <StageAction row={row.original} />
      </div>
    ),
  },
  { id: "version", header: text.columns.version, size: 120, cell: ({ row }) => row.original.version },
  {
    id: "stage",
    header: text.columns.stage,
    size: 130,
    cell: ({ row }) => (
      <div>
        <Badge
          tone={
            row.original.stage === "production"
              ? "success"
              : row.original.stage === "unknown"
                ? "warning"
                : "muted"
          }
        >
          {text.stages[row.original.stage]}
        </Badge>
        {!row.original.registered ? <p className="muted">{text.unregistered}</p> : null}
      </div>
    ),
  },
  {
    id: "calls",
    header: text.columns.calls,
    size: 110,
    cell: ({ row }) => formatNumber(row.original.calls),
  },
  {
    id: "errors",
    header: text.columns.errors,
    size: 116,
    cell: ({ row }) => formatNumber(row.original.errors),
  },
  {
    id: "evaluation",
    header: text.columns.evaluation,
    size: 140,
    cell: ({ row }) => formatNumber(row.original.evaluation_failures),
  },
  {
    id: "eligible",
    header: text.columns.eligible,
    size: 174,
    cell: ({ row }) => (row.original.eligible_stage ? text.stages[row.original.eligible_stage] : text.none),
  },
  {
    id: "updated",
    header: text.columns.updated,
    size: 180,
    cell: ({ row }) =>
      row.original.updated_at ? (
        <time dateTime={row.original.updated_at}>{formatDateTime(row.original.updated_at)}</time>
      ) : row.original.registered ? (
        text.unknown
      ) : (
        text.unregistered
      ),
  },
];

export function PromptStagesTab() {
  const { backendVersion } = useAuth();
  if (!versionAtLeast(backendVersion, "v0.86.132"))
    return (
      <InlineNotice tone="info" title={text.tab}>
        {text.support}
      </InlineNotice>
    );
  return <PromptStagesContent />;
}
function PromptStagesContent() {
  const [params, update] = useSearchState();
  const access = useLibraryAccess();
  const busy = useLibraryBusy();
  const stage = promptStages.find((value) => value === params.get("stages_stage")) ?? "all";
  const window = stageWindows.find((value) => value === params.get("stages_window")) ?? "7d";
  const size = [25, 50, 100].includes(Number(params.get("stages_size")))
    ? Number(params.get("stages_size"))
    : 25;
  const page = Math.min(pageFromParam(params.get("stages_page")), Math.floor(1_000_000 / size) + 1),
    offset = (page - 1) * size;
  const query = useLibraryQuery({
    key: ["prompts", "stages", window, stage, size, offset],
    read: (prefixes, signal) =>
      readPromptStages({ view: "workspace", window, stage, limit: size, offset }, prefixes, signal),
  });
  const [editing, setEditing] = useState<PromptStageWorkspaceItem>();
  const trigger = useRef<HTMLElement | null>(null);
  const data = query.data;
  return (
    <div className="page-stack">
      <InlineNotice tone="info" title={text.tab}>
        {text.scope}
      </InlineNotice>
      <SectionCard title={text.tab} description={text.help}>
        <div className="toolbar">
          <label className="toolbar">
            <span>{text.period}</span>
            <Select
              aria-label={text.period}
              value={window}
              onChange={(event) =>
                update({ stages_window: event.target.value, stages_page: null }, { replace: false })
              }
            >
              {stageWindows.map((value) => (
                <option key={value} value={value}>
                  {text.windows[value]}
                </option>
              ))}
            </Select>
          </label>
          <label className="toolbar">
            <span>{text.stageFilter}</span>
            <Select
              aria-label={text.stageFilter}
              value={stage}
              onChange={(event) =>
                update({ stages_stage: event.target.value, stages_page: null }, { replace: false })
              }
            >
              {(["all", ...promptStages] as const).map((value) => (
                <option key={value} value={value}>
                  {text.stages[value]}
                </option>
              ))}
            </Select>
          </label>
        </div>
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
            조건에 맞는 버전 {formatNumber(data.total)}개 · 현재 페이지 {formatNumber(data.items.length)}개 ·
            마지막 정상 조회 {formatDateTime(data.until)}
          </p>
        ) : null}
        <StageActionContext.Provider
          value={{
            blocked: !access.allowed || busy || query.isError,
            reason: !access.allowed ? access.reason : undefined,
            open: (row, element) => {
              trigger.current = element;
              setEditing(row);
            },
          }}
        >
          <DataTable
            tableId="prompt-stages"
            lockedColumnIds={["name", "version", "stage"]}
            caption={text.caption}
            columns={columns}
            data={data?.items ?? []}
            loading={query.isPending}
            error={query.isError && !data ? text.failed : undefined}
            onRetry={() => void query.refetch()}
            pageCount={
              data?.items.length === 0
                ? 1
                : Math.max(
                    1,
                    Math.min(Math.ceil((data?.total ?? 0) / size), Math.floor(1_000_000 / size) + 1),
                  )
            }
            pageIndex={page - 1}
            onPageChange={(index) => update({ stages_page: index + 1 }, { replace: false })}
            emptyMessage={page > 1 ? text.pageEmpty : text.empty}
            pageSizeControl={{
              value: size,
              options: [25, 50, 100],
              onChange: (value) => update({ stages_size: value, stages_page: null }, { replace: false }),
            }}
          />
        </StageActionContext.Provider>
        {data && data.items.length === 0 && page > 1 ? (
          <Button onClick={() => update({ stages_page: null }, { replace: false })}>{text.first}</Button>
        ) : null}
        <p className="muted">{text.evaluationHelp}</p>
        {data ? (
          <details>
            <summary>{text.criteria}</summary>
            <ul>
              {data.criteria.map((criterion) => (
                <li key={criterion.stage}>
                  {text.stages[criterion.stage]}: {text.callsCriterion}{" "}
                  {formatNumber(criterion.minimum_calls)} · {text.errorCriterion}{" "}
                  {formatNumber(criterion.maximum_error_rate * 100)}% · {text.evaluationCriterion}{" "}
                  {criterion.maximum_evaluation_failures_per_call}
                </li>
              ))}
            </ul>
            <p className="muted">
              관측 범위: {formatDateTime(data.since)} 이상 ~ {formatDateTime(data.until)} 미만
            </p>
          </details>
        ) : null}
      </SectionCard>
      {editing ? (
        <PromptStageDialog row={editing} onClose={() => setEditing(undefined)} returnFocusRef={trigger} />
      ) : null}
    </div>
  );
}
