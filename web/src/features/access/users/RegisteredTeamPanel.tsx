import { useRef, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import type { AuthTeamRow } from "@/shared/api/domains/access.schemas";
import type { RegisteredTeamPage } from "@/shared/api/domains/team-page.schemas";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { DataTable, type DataTableSort } from "@/shared/data-table/DataTable";
import type { DataTableColumn } from "@/shared/data-table/columns";
import { DataTableSortControls } from "@/shared/data-table/DataTableSortControls";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import type { SearchUpdates } from "@/shared/hooks/use-search-state";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { formatNumber } from "@/shared/utils/format";
import {
  registeredTeamSortColumns,
  validTeamSearch,
  type RegisteredTeamState,
} from "./registered-team-model";

export function RegisteredTeamPanel({
  result,
  state,
  update,
  columns,
  owner,
  actions,
  reason,
  protectedId,
}: {
  result: UseQueryResult<RegisteredTeamPage>;
  state: RegisteredTeamState;
  update: (updates: SearchUpdates) => void;
  columns: ReadonlyArray<DataTableColumn<AuthTeamRow>>;
  owner: FeatureReadOwner;
  actions: ReactNode;
  reason?: string;
  protectedId: (value: string) => boolean;
}) {
  const { credentialPrefixes } = useAuth();
  const [search, setSearch] = useState(state.search);
  const [source, setSource] = useState(state.search);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  if (source !== state.search) {
    setSource(state.search);
    setSearch(state.search);
    setError(undefined);
  }
  const rows = result.data?.auth_teams ?? [];
  const total = result.data?.total;
  const pages = total === undefined ? state.page + 1 : Math.max(1, Math.ceil(total / state.size));
  const sort = (value: readonly DataTableSort[]) =>
    update({
      registered_sort: value.map((row) => `${row.columnId}:${row.direction}`).join(","),
      registered_page: undefined,
    });
  return (
    <SectionCard
      title="등록된 팀"
      description="팀 이름·ID로 검색하고 새 팀을 추가하거나 기존 팀 이름을 수정합니다."
      actions={actions}
    >
      {reason ? <InlineNotice tone="info">{reason}</InlineNotice> : null}
      <form
        aria-label="등록 팀 검색"
        onSubmit={(event) => {
          event.preventDefault();
          const value = search.trim();
          if (!validTeamSearch(value, credentialPrefixes)) {
            setError("검색은 200자 이내로 입력하세요. 비밀값과 제어 문자는 사용할 수 없습니다.");
            input.current?.focus();
            return;
          }
          setError(undefined);
          update({ registered_q: value, registered_page: undefined });
        }}
      >
        <Toolbar
          label="등록 팀 필터"
          end={
            <>
              <Button type="submit" variant="primary">
                필터 적용
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setSearch("");
                  setError(undefined);
                  update({ registered_q: undefined, registered_sort: undefined, registered_page: undefined });
                }}
              >
                필터 초기화
              </Button>
            </>
          }
        >
          <FormField label="팀 검색" description="팀 이름 또는 팀 ID" error={error}>
            {(control) => (
              <Input
                {...control}
                ref={input}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            )}
          </FormField>
        </Toolbar>
      </form>
      <Toolbar
        label="등록 팀 정렬과 내보내기"
        end={
          <>
            <DataTableSortControls
              columns={registeredTeamSortColumns}
              value={state.sorts}
              onChange={sort}
              maxCriteria={3}
            />
            <Button
              variant="secondary"
              disabled={!result.data || result.isFetching || result.isError || !rows.length}
              onClick={() => {
                if (!owner.isCurrent()) return;
                downloadCsv(
                  "registered-teams-page.csv",
                  toCsv(rows, [
                    { header: "팀 ID", value: (row) => (protectedId(row.id) ? "보호된 팀 ID" : row.id) },
                    {
                      header: "팀 이름",
                      value: (row) => (protectedId(row.name) ? "보호된 팀 이름" : row.name),
                    },
                    { header: "생성 시각 (ISO 8601)", value: (row) => row.created_at },
                    { header: "수정 시각 (ISO 8601)", value: (row) => row.updated_at },
                  ]),
                );
              }}
            >
              현재 페이지 CSV
            </Button>
          </>
        }
      >
        <p className="access-note" role="status">
          {total === undefined ? "등록 팀 수 미확인" : `검색 결과 ${formatNumber(total)}개 팀`} · 검색·정렬은
          조회 가능한 전체 등록 팀에 적용됩니다.
        </p>
      </Toolbar>
      {result.isError ? (
        <QueryNotice
          error={result.error}
          hasData={Boolean(result.data)}
          label="등록 팀 목록"
          onRetry={() => void result.refetch()}
        />
      ) : null}
      {total !== undefined && state.page >= pages ? (
        <InlineNotice tone="info">
          현재 페이지에 등록 팀이 없습니다.{" "}
          <Button size="small" onClick={() => update({ registered_page: pages })}>
            마지막 페이지로 이동
          </Button>
        </InlineNotice>
      ) : null}
      {result.data || result.isPending ? (
        <DataTable
          caption="등록된 팀 목록"
          columns={columns}
          data={rows}
          tableId="access.users.registered-teams"
          lockedColumnIds={["name", "actions"]}
          getRowId={(row) => row.id}
          loading={result.isPending}
          emptyMessage="조건에 맞는 등록 팀이 없습니다. 검색 조건을 바꾸거나 등록된 팀을 확인하세요."
          pageCount={Math.max(pages, state.page + 1)}
          pageIndex={state.page}
          onPageChange={(page) => update({ registered_page: page + 1 })}
          pageSizeControl={{
            value: state.size,
            options: [10, 25, 50],
            onChange: (size) => update({ registered_size: size, registered_page: undefined }),
          }}
          sorting={{
            columns: registeredTeamSortColumns,
            value: state.sorts[0],
            onChange: (value) => sort([value]),
          }}
        />
      ) : null}
      <UpdatedAt at={result.dataUpdatedAt} />
    </SectionCard>
  );
}
