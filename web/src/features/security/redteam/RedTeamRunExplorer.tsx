import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { assertFeatureRead, featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { readRunQuery } from "@/shared/utils/redteam-run-query";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { DataTable } from "@/shared/data-table/DataTable";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { readRunHistory } from "./run-history-api";
import { useRunHistoryOwner } from "./run-history-context";
import { RunHistoryFilters } from "./RunHistoryFilters";
import { runSortLabels } from "./run-history-labels";
import { runColumns } from "./run-columns";
import { PanelFailure } from "./RedTeamParts";

export function RedTeamRunExplorer({
  onOpen,
}: {
  onOpen: (id: string, event: { currentTarget: HTMLElement }) => void;
}) {
  const owner = useRunHistoryOwner();
  const { credentialPrefixes } = useAuth();
  const [params, update] = useSearchState();
  const search = readRunQuery(params, credentialPrefixes);
  const interval = useRefreshInterval();
  const query = useQuery({
    queryKey: owner
      ? featureOwnedKey(["redteam", "runs", "page", search.query], owner)
      : ["redteam", "no-history-owner"],
    enabled: Boolean(owner?.readable && !owner.denied && search.valid),
    gcTime: 0,
    retry: false,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      if (!owner) throw new Error("조회 권한을 확인하세요.");
      assertFeatureRead(owner, signal);
      const result = await readRunHistory(search.query, credentialPrefixes, signal);
      assertFeatureRead(owner, signal);
      return result;
    },
  });
  const pageCount = Math.max(
    1,
    Math.min(Math.ceil((query.data?.total ?? 0) / search.size), Math.floor(1_000_000 / search.size) + 1),
  );
  const firstSort = (search.query.sort ?? "created_at:desc").split(",")[0]?.split(":");
  return (
    <SectionCard
      className="rt-run-explorer"
      title="실행 이력"
      description="전체 이력에서 조건에 맞는 실행을 찾습니다. 중단된 실행은 일부 결과만 포함할 수 있습니다."
    >
      <div className="rt-stack">
        <RunHistoryFilters />
        <div className="rt-history-summary" role="status">
          <span>
            {query.data ? `조건에 맞는 실행 ${formatNumber(query.data.total)}건` : "실행 이력 조회"}
          </span>
          {query.data ? (
            <time dateTime={query.data.generated_at}>
              마지막 조회 {formatDateTime(query.data.generated_at)}
            </time>
          ) : null}
          <Button size="small" onClick={() => void query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? "조회 중…" : "이력 새로고침"}
          </Button>
        </div>
        {query.isError ? (
          <PanelFailure
            error={query.error}
            hasData={Boolean(query.data)}
            label="실행 이력"
            onRetry={() => void query.refetch()}
          />
        ) : null}
        <DataTable
          caption="레드팀 캠페인 실행 이력"
          getRowId={(row) => row.id}
          tableId="redteam-run-history"
          lockedColumnIds={["id", "actions"]}
          columns={runColumns(
            (run, event) => onOpen(run.id, event),
            true,
            (id) => {
              const query = new URLSearchParams(params);
              query.set("tab", "runs");
              query.set("run", id);
              return `/redteam?${query.toString()}`;
            },
          )}
          data={query.data?.runs ?? []}
          loading={query.isPending}
          error={query.isError && !query.data ? "실행 이력을 불러오지 못했습니다." : undefined}
          emptyMessage="조건에 맞는 실행 이력이 없습니다. 조건을 조정하거나 초기화하세요."
          onRetry={() => void query.refetch()}
          pageIndex={search.page - 1}
          pageCount={pageCount}
          onPageChange={(page) => update({ runs_page: page + 1 }, { replace: false })}
          pageSizeControl={{
            value: search.size,
            options: [25, 50, 100],
            onChange: (size) => update({ runs_size: size, runs_page: null }, { replace: false }),
          }}
          sorting={{
            columns: Object.entries(runSortLabels).map(([id, sortLabel]) => ({ id, sortLabel })),
            value: {
              columnId: firstSort?.[0] ?? "created_at",
              direction: firstSort?.[1] === "asc" ? "asc" : "desc",
            },
            onChange: (sort) =>
              update(
                { runs_sort: `${sort.columnId}:${sort.direction}`, runs_page: null },
                { replace: false },
              ),
          }}
        />
        {query.data && search.page > pageCount ? (
          <Button onClick={() => update({ runs_page: null }, { replace: false })}>첫 페이지로 이동</Button>
        ) : null}
        <p className="rt-muted">
          새 실행이나 상태 변경으로 페이지별 결과가 달라질 수 있습니다. 원본 결과 ID로 재실행 이력을 좁혀
          확인하세요.
        </p>
      </div>
    </SectionCard>
  );
}
