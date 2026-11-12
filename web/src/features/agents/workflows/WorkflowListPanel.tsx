import { useCallback, useRef, useState, type RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { ErrorState } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { DataTable, type DataTableSort } from "@/shared/data-table/DataTable";
import { DataTableSortControls } from "@/shared/data-table/DataTableSortControls";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { isAppError } from "@/shared/api/error";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import type { SearchUpdates } from "@/shared/hooks/use-search-state";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import {
  validWorkflowDetailId,
  validWorkflowSearch,
  workflowSortColumns,
  type WorkflowPageState,
} from "./workflow-page-model";
import type { useWorkflowPageQuery } from "./use-workflow-queries";
import { useWorkflowColumns } from "./workflow-tables";

export function WorkflowListPanel({
  state,
  result,
  owner,
  update,
  returnFocusRef,
}: {
  state: WorkflowPageState;
  result: ReturnType<typeof useWorkflowPageQuery>;
  owner: FeatureReadOwner;
  update: (updates: SearchUpdates) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { credentialPrefixes } = useAuth();
  const [search, setSearch] = useState(state.search);
  const [source, setSource] = useState(state.search);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  if (source !== state.search) {
    setSource(state.search);
    setSearch(state.search);
    setError("");
  }
  const rows = result.data?.workflows ?? [];
  const remember = useCallback(
    (trigger: HTMLElement) => {
      if (!owner.isCurrent()) return false;
      returnFocusRef.current = trigger;
      return true;
    },
    [owner, returnFocusRef],
  );
  const { columns } = useWorkflowColumns(rows, remember);
  const total = result.data?.total;
  const pages = total === undefined ? state.page + 1 : Math.max(1, Math.ceil(total / state.size));
  const sort = (values: readonly DataTableSort[]) =>
    update({
      sort: values.map((value) => `${value.columnId}:${value.direction}`).join(","),
      page: undefined,
    });
  return (
    <>
      <Toolbar label="워크플로 필터">
        <form
          className="agents-toolbar-field"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const next = search.trim();
            if (!validWorkflowSearch(next, credentialPrefixes)) {
              setError(
                containsPotentialSecret(next, credentialPrefixes)
                  ? secretSearchMessage
                  : "검색어는 200자 이내로 입력하세요. 비밀값과 제어 문자는 사용할 수 없습니다.",
              );
              input.current?.focus();
              return;
            }
            setError("");
            update({ q: next || undefined, page: undefined });
          }}
        >
          <label htmlFor="workflow-search">워크플로 검색</label>
          <Input
            ref={input}
            id="workflow-search"
            name="q"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="이름, 설명, 팀 또는 ID"
            aria-invalid={error ? "true" : undefined}
            aria-describedby={error ? "workflow-search-error" : undefined}
          />
          {error ? (
            <span id="workflow-search-error" className="field-error" role="alert">
              {error}
            </span>
          ) : null}
          <Button type="submit">검색 적용</Button>
        </form>
        <label className="agents-toolbar-field" htmlFor="workflow-status">
          <span>상태</span>
          <Select
            id="workflow-status"
            value={state.status}
            options={[
              { value: "all", label: "전체 상태" },
              { value: "enabled", label: "사용" },
              { value: "disabled", label: "중지" },
            ]}
            onChange={(event) =>
              update({
                status: event.target.value === "all" ? undefined : event.target.value,
                page: undefined,
              })
            }
          />
        </label>
        <Button
          onClick={() => {
            setSearch("");
            setError("");
            update({ q: undefined, status: undefined, sort: undefined, page: undefined });
          }}
        >
          필터 초기화
        </Button>
      </Toolbar>
      <Toolbar label="워크플로 목록 작업">
        <p role="status">
          {total === undefined ? "워크플로 수 미확인" : `검색 결과 ${formatNumber(total)}개`} · 검색·정렬은
          전체 워크플로에 적용됩니다.
        </p>
        <DataTableSortControls
          columns={workflowSortColumns}
          value={state.sorts}
          onChange={sort}
          maxCriteria={3}
        />
        <Button
          disabled={!result.data || result.isFetching || result.isError || rows.length === 0}
          onClick={() => {
            if (!owner.isCurrent()) return;
            downloadCsv(
              "workflows-page.csv",
              toCsv(rows, [
                { header: "ID", value: (row) => row.id },
                { header: "이름", value: (row) => row.name },
                { header: "단계 수", value: (row) => row.step_count },
                { header: "허용 팀", value: (row) => row.allowed_teams },
                { header: "상태", value: (row) => (row.enabled ? "사용" : "중지") },
                { header: "생성 시각 (ISO 8601)", value: (row) => row.created_at },
                { header: "수정 시각 (ISO 8601)", value: (row) => row.updated_at },
              ]),
            );
          }}
        >
          현재 페이지 CSV
        </Button>
      </Toolbar>
      {result.isError ? (
        <ErrorState
          message={safeAppErrorMessage(result.error, "워크플로 목록을 불러오지 못했습니다.")}
          requestId={isAppError(result.error) ? result.error.requestId : undefined}
          onRetry={() => void result.refetch()}
          legacyHref="/admin#/workflows"
        />
      ) : null}
      {total !== undefined && state.page >= pages ? (
        <InlineNotice tone="info">
          현재 페이지에 워크플로가 없습니다.{" "}
          <Button size="small" onClick={() => update({ page: pages })}>
            마지막 페이지로 이동
          </Button>
        </InlineNotice>
      ) : null}
      {result.data || result.isPending ? (
        <DataTable
          caption="정의된 워크플로 목록"
          columns={columns}
          data={rows}
          tableId="agents.workflows.list"
          lockedColumnIds={["name"]}
          getRowId={(row) => row.id}
          getRowActionLabel={(row) => `${row.name || row.id} 상세 열기`}
          emptyMessage={
            result.data?.summary.total === 0
              ? "아직 워크플로가 없습니다. 새 워크플로를 등록하세요."
              : "조건에 맞는 워크플로가 없습니다. 필터를 바꾸세요."
          }
          loading={result.isPending}
          pageCount={Math.max(pages, state.page + 1)}
          pageIndex={state.page}
          onPageChange={(page) => update({ page: page + 1 })}
          pageSizeControl={{
            value: state.size,
            options: [10, 25, 50],
            onChange: (size) => update({ size, page: undefined }),
          }}
          sorting={{
            columns: workflowSortColumns,
            value: state.sorts[0],
            onChange: (value) => sort([value]),
          }}
          onRowClick={(row) => {
            if (!owner.isCurrent() || !validWorkflowDetailId(row.id, credentialPrefixes)) return;
            returnFocusRef.current = document.activeElement as HTMLElement | null;
            update({ workflow: row.id });
          }}
        />
      ) : null}
      <p className="agents-updated">마지막 갱신 {formatDateTime(result.dataUpdatedAt)}</p>
    </>
  );
}
