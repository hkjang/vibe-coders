import { useCallback, useMemo, type ReactNode } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { managedRoleLabel } from "@/config/ui-labels";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { statusLabel } from "@/features/access/access-format";
import type { AuthUserRow } from "@/shared/api/domains/access.schemas";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { DataTable, type DataTableSort } from "@/shared/data-table/DataTable";
import { DataTableSortControls } from "@/shared/data-table/DataTableSortControls";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { formatNumber } from "@/shared/utils/format";
import { AccountFilters } from "./AccountFilters";
import { AccountDetail } from "./AccountDetail";
import { accountSortColumns, readAccountPage } from "./account-page-model";
import { accountColumns } from "./user-columns";
import { useAccountPageQuery } from "./use-access-admin";
import "./account-page.css";

export function AccountListPanel({
  owner,
  allowed,
  reason,
  actions,
  onEdit,
}: {
  owner: FeatureReadOwner;
  allowed: boolean;
  reason: string;
  actions: ReactNode;
  onEdit: (row: AuthUserRow, trigger: HTMLElement) => void;
}) {
  const { credentialPrefixes } = useAuth();
  const [params, update] = useSearchState();
  const { returnFocusRef, remember } = useReturnFocus();
  const openDetail = useCallback(
    (trigger: HTMLElement) => {
      if (!owner.isCurrent()) return false;
      remember(trigger);
      return true;
    },
    [owner, remember],
  );
  const state = readAccountPage(params, credentialPrefixes);
  const result = useAccountPageQuery(state.query, owner);
  const rows = useMemo(() => result.data?.accounts ?? [], [result.data]);
  const names = useMemo(
    () => Object.fromEntries(rows.map((row) => [row.team_id, row.team_name || row.team_id])),
    [rows],
  );
  const columns = useMemo(
    () => accountColumns(names, onEdit, allowed, reason, openDetail),
    [names, onEdit, allowed, reason, openDetail],
  );
  const total = result.data?.total;
  const pages = total === undefined ? state.page + 1 : Math.max(1, Math.ceil(total / state.size));
  const sort = (value: readonly DataTableSort[]) =>
    update({
      account_sort: value.map((row) => `${row.columnId}:${row.direction}`).join(","),
      account_page: undefined,
    });
  return (
    <SectionCard
      title="로그인 계정"
      description="조회 권한이 있는 로그인 계정을 검색하고 역할·상태·팀을 관리합니다."
      actions={actions}
    >
      {!allowed ? <InlineNotice tone="info">{reason}</InlineNotice> : null}
      {params.has("account_id") ? (
        <AccountDetail
          key={params.getAll("account_id").join("\u0000")}
          values={params.getAll("account_id")}
          owner={owner}
          onClose={() => update({ account_id: undefined })}
          returnFocusRef={returnFocusRef}
        />
      ) : null}
      <AccountFilters state={state} update={update} />
      <div className="account-page-actions">
        <p className="access-note" role="status">
          {total === undefined ? "계정 수 미확인" : `검색 결과 ${formatNumber(total)}개 계정`} · 검색·정렬은
          조회 가능한 전체 계정에 적용됩니다.
        </p>
        <DataTableSortControls
          columns={accountSortColumns}
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
              "login-accounts-page.csv",
              toCsv(rows, [
                { header: "계정 ID", value: (row) => row.id },
                { header: "이메일", value: (row) => row.email },
                { header: "이름", value: (row) => row.name },
                { header: "역할", value: (row) => managedRoleLabel(row.role) },
                { header: "상태", value: (row) => statusLabel(row.status) },
                { header: "팀 ID", value: (row) => row.team_id },
                { header: "팀", value: (row) => row.team_name },
                { header: "생성 시각 (ISO 8601)", value: (row) => row.created_at },
              ]),
            );
          }}
        >
          현재 페이지 CSV
        </Button>
      </div>
      {result.isError ? (
        <QueryNotice
          error={result.error}
          hasData={Boolean(result.data)}
          label="로그인 계정"
          onRetry={() => void result.refetch()}
        />
      ) : null}
      {total !== undefined && state.page >= pages ? (
        <InlineNotice tone="info">
          현재 페이지에 계정이 없습니다.{" "}
          <Button size="small" onClick={() => update({ account_page: pages })}>
            마지막 페이지로 이동
          </Button>
        </InlineNotice>
      ) : null}
      {result.data || result.isPending ? (
        <DataTable
          caption="로그인 계정 목록"
          columns={columns}
          data={rows}
          tableId="access.users.accounts"
          lockedColumnIds={["email", "actions"]}
          getRowId={(row) => row.id}
          loading={result.isPending}
          emptyMessage="조건에 맞는 로그인 계정이 없습니다. 필터를 바꾸거나 새 사용자를 등록하세요."
          pageCount={Math.max(pages, state.page + 1)}
          pageIndex={state.page}
          onPageChange={(page) => update({ account_page: page + 1 })}
          pageSizeControl={{
            value: state.size,
            options: [10, 25, 50],
            onChange: (size) => update({ account_size: size, account_page: undefined }),
          }}
          sorting={{
            columns: accountSortColumns.filter((column) => column.id !== "team_name"),
            value: state.sorts[0],
            onChange: (value) => sort([value]),
          }}
        />
      ) : null}
      <UpdatedAt at={result.dataUpdatedAt} />
    </SectionCard>
  );
}
