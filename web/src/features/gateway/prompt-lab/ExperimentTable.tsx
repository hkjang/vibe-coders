import { useState, useRef, useMemo } from "react";
import { Link } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import type { PromptExperiment } from "@/shared/api/domains/gateway.schemas";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { FormField } from "@/shared/components/form/FormField";
import { DataTable } from "@/shared/data-table/DataTable";
import { createDataTableColumnHelper } from "@/shared/data-table/columns";
import { pageFromParam, useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { sanitizeAppRouteSearch } from "@/shared/security/app-route-query";
import { formatDateTime } from "@/shared/utils/format";
import type { PromptLabController } from "./use-prompt-lab-controller";

const helper = createDataTableColumnHelper<PromptExperiment>();
const statusLabel = (status: string | null | undefined) =>
  status === "active" ? "진행 중" : status === "archived" ? "보관" : "미확인";
export function ExperimentTable({ lab }: { lab: PromptLabController }) {
  const { returnFocusRef, setArchiveTarget, setRemoveExperiment, canWrite } = lab;
  const fetching = lab.experiments.isFetching;
  const { credentialPrefixes } = useAuth();
  const [params, update] = useSearchState();
  const search = (params.get("q") ?? "").trim().toLocaleLowerCase();
  const requestedStatus = params.get("status");
  const status = requestedStatus === "active" || requestedStatus === "archived" ? requestedStatus : "all";
  const sort = params.get("sort") === "name" ? "name" : "recent";
  const rows = (lab.experiments.data?.experiments ?? [])
    .filter(
      (row) =>
        (status === "all" || row.status === status) &&
        (!search ||
          [row.title, row.team ?? "", row.owner ?? ""].some((value) =>
            value.toLocaleLowerCase().includes(search),
          )),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title, "ko")
        : (b.created_at ?? "").localeCompare(a.created_at ?? ""),
    );
  const pages = Math.max(1, Math.ceil(rows.length / 25));
  const page = Math.min(pageFromParam(params.get("page")) - 1, pages - 1);
  const searchString = params.toString();
  const columns = useMemo(
    () => [
      helper.display({
        id: "title",
        header: "제목",
        cell: ({ row }) => {
          const next = new URLSearchParams(searchString);
          next.set("exp", row.original.id);
          const safe = sanitizeAppRouteSearch("/prompts/lab", next.toString(), credentialPrefixes);
          return (
            <Link
              to={{ pathname: "/prompts/lab", search: safe.search }}
              aria-label={`${row.original.title} 테스트 케이스 보기`}
            >
              {row.original.title}
            </Link>
          );
        },
      }),
      helper.display({ id: "team", header: "팀", cell: ({ row }) => row.original.team || "미등록" }),
      helper.display({ id: "owner", header: "담당자", cell: ({ row }) => row.original.owner || "미등록" }),
      helper.display({ id: "status", header: "상태", cell: ({ row }) => statusLabel(row.original.status) }),
      helper.display({
        id: "created",
        header: "등록 시각",
        cell: ({ row }) => formatDateTime(row.original.created_at),
      }),
      helper.display({
        id: "actions",
        header: "작업",
        cell: ({ row }) => (
          <div className="gateway-row-actions">
            <Button
              size="small"
              variant="ghost"
              disabled={!canWrite || fetching || !["active", "archived"].includes(row.original.status ?? "")}
              aria-label={`${row.original.title} 실험 ${row.original.status === "archived" ? "다시 진행" : "보관"}`}
              onClick={(event) => {
                returnFocusRef.current = event.currentTarget;
                setArchiveTarget(structuredClone(row.original));
              }}
            >
              {row.original.status === "archived" ? "다시 진행" : "보관"}
            </Button>
            <Button
              size="small"
              variant="ghost"
              disabled={!canWrite || fetching}
              aria-label={`${row.original.title} 실험 삭제`}
              onClick={(event) => {
                returnFocusRef.current = event.currentTarget;
                setRemoveExperiment(structuredClone(row.original));
              }}
            >
              삭제
            </Button>
          </div>
        ),
      }),
    ],
    [
      searchString,
      credentialPrefixes,
      returnFocusRef,
      setArchiveTarget,
      setRemoveExperiment,
      canWrite,
      fetching,
    ],
  );
  return (
    <div className="page-stack">
      <Search
        key={params.get("q") ?? ""}
        value={params.get("q") ?? ""}
        apply={(q) => update({ q, page: undefined })}
      />
      <div className="toolbar">
        <FormField label="실험 상태">
          {(control) => (
            <Select
              {...control}
              value={status}
              onChange={(event) =>
                update({
                  status: event.target.value === "all" ? undefined : event.target.value,
                  page: undefined,
                })
              }
              options={[
                { value: "all", label: "전체" },
                { value: "active", label: "진행 중" },
                { value: "archived", label: "보관" },
              ]}
            />
          )}
        </FormField>
        <FormField label="정렬">
          {(control) => (
            <Select
              {...control}
              value={sort}
              onChange={(event) =>
                update({
                  sort: event.target.value === "recent" ? undefined : event.target.value,
                  page: undefined,
                })
              }
              options={[
                { value: "recent", label: "최근 등록순" },
                { value: "name", label: "제목순" },
              ]}
            />
          )}
        </FormField>
        <Button onClick={() => void lab.experiments.refetch()} disabled={fetching}>
          새로고침
        </Button>
      </div>
      <p className="muted">
        수신한 {lab.experiments.data?.experiments.length ?? 0}개 실험 중 {rows.length}개 · 페이지당 25개
      </p>
      <DataTable
        caption="등록된 프롬프트 실험"
        columns={columns}
        data={rows.slice(page * 25, (page + 1) * 25)}
        getRowId={(row) => row.id}
        tableId="prompt-lab-experiments"
        lockedColumnIds={["title", "actions"]}
        pageIndex={page}
        pageCount={pages}
        onPageChange={(next) => update({ page: next + 1 })}
        emptyMessage="검색 조건에 맞는 실험이 없습니다."
      />
    </div>
  );
}
function Search({ value, apply }: { value: string; apply: (value: string) => void }) {
  const { credentialPrefixes } = useAuth();
  const [draft, setDraft] = useState(value),
    [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  return (
    <form
      className="toolbar"
      onSubmit={(event) => {
        event.preventDefault();
        if (containsPotentialSecret(draft, credentialPrefixes)) {
          setError("비밀값이 포함된 검색어는 사용할 수 없습니다.");
          input.current?.focus();
          return;
        }
        setError(undefined);
        apply(draft.trim());
      }}
    >
      <FormField label="실험 검색" description="제목, 팀 또는 담당자로 검색합니다." error={error}>
        {(control) => (
          <Input
            {...control}
            ref={input}
            value={draft}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
          />
        )}
      </FormField>
      <Button type="submit">검색</Button>
      <Button
        onClick={() => {
          setDraft("");
          setError(undefined);
          apply("");
        }}
      >
        검색 초기화
      </Button>
    </form>
  );
}
