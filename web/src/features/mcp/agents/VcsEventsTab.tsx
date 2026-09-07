import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { QueryNotice } from "@/features/mcp/mcp-ui";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime } from "@/shared/utils/format";

const routeId = "agents.registry";
const kindOptions = [
  { value: "", label: "전체" },
  { value: "commit", label: "commit (커밋)" },
  { value: "merge_request", label: "merge_request (병합 요청)" },
];

interface VcsRow {
  id: string;
  provider: string;
  kind: string;
  repo: string;
  branch: string;
  title: string;
  url: string;
  author_name: string;
  author_email: string;
  state: string;
  session_id: string;
  api_key_id: string;
  created_at: string;
}

const column = createDataTableColumnHelper<VcsRow>();
const columns = [
  column.accessor((row) => row.kind, {
    id: "kind",
    header: "유형",
    cell: (info) => (
      <Badge tone={info.getValue<string>() === "merge_request" ? "info" : "muted"}>
        {info.getValue<string>() || "—"}
      </Badge>
    ),
  }),
  column.accessor((row) => row.title, {
    id: "title",
    header: "제목 / 저장소",
    cell: (info) => (
      <div>
        <strong className="truncate">{info.getValue<string>() || "(제목 없음)"}</strong>
        <div className="mono truncate">{info.row.original.repo}</div>
      </div>
    ),
  }),
  column.accessor((row) => row.branch || "—", { id: "branch", header: "브랜치" }),
  column.accessor((row) => row.author_name || row.author_email || "—", { id: "author", header: "작성자" }),
  column.accessor((row) => row.state || "—", { id: "state", header: "상태" }),
  column.accessor((row) => row.session_id || "—", {
    id: "session",
    header: "세션",
    cell: (info) => <span className="mono truncate">{info.getValue<string>()}</span>,
  }),
  column.accessor((row) => formatDateTime(row.created_at), { id: "created", header: "시각" }),
] as ReadonlyArray<DataTableColumn<VcsRow>>;

export function VcsEventsTab(): React.JSX.Element {
  const [params, updateParams] = useSearchState();
  const [searchError, setSearchError] = useState<string | undefined>();

  const repo = params.get("repo") ?? "";
  const sessionId = params.get("session_id") ?? "";
  const apiKeyId = params.get("api_key_id") ?? "";
  const kind = params.get("kind") ?? "";

  const events = useQuery({
    queryKey: ["agents", "vcs", repo, sessionId, apiKeyId, kind],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.mcp.agents.vcsEvents, {
        query: {
          ...(repo ? { repo } : {}),
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(apiKeyId ? { api_key_id: apiKeyId } : {}),
          ...(kind ? { kind } : {}),
          limit: 100,
        },
        signal,
        routeId,
      }),
  });

  const applyFilters = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values = {
      repo: String(data.get("repo") ?? "").trim(),
      session_id: String(data.get("session_id") ?? "").trim(),
      api_key_id: String(data.get("api_key_id") ?? "").trim(),
      kind: String(data.get("kind") ?? ""),
    };
    if (Object.values(values).some((value) => containsPotentialSecret(value))) {
      setSearchError(secretSearchMessage);
      return;
    }
    setSearchError(undefined);
    updateParams({
      repo: values.repo || undefined,
      session_id: values.session_id || undefined,
      api_key_id: values.api_key_id || undefined,
      kind: values.kind || undefined,
    });
  };

  const rows = events.data?.events ?? [];

  return (
    <div className="mcp-section-stack">
      <SectionCard
        title="VCS 이벤트 필터"
        description="프롬프트에서 커밋·병합 요청까지의 연결을 저장소나 세션 기준으로 확인합니다."
      >
        <form className="mcp-filter-grid" onSubmit={applyFilters}>
          <label htmlFor="vcs-repo">
            저장소
            <Input id="vcs-repo" name="repo" defaultValue={repo} key={`repo-${repo}`} />
          </label>
          <label htmlFor="vcs-session">
            세션 ID
            <Input id="vcs-session" name="session_id" defaultValue={sessionId} key={`session-${sessionId}`} />
          </label>
          <label htmlFor="vcs-key">
            API 키 ID
            <Input id="vcs-key" name="api_key_id" defaultValue={apiKeyId} key={`key-${apiKeyId}`} />
          </label>
          <label htmlFor="vcs-kind">
            유형
            <Select
              id="vcs-kind"
              name="kind"
              defaultValue={kind}
              options={kindOptions}
              key={`kind-${kind}`}
            />
          </label>
          <div className="mcp-row-actions">
            <Button type="submit" variant="primary">
              적용
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                updateParams({
                  repo: undefined,
                  session_id: undefined,
                  api_key_id: undefined,
                  kind: undefined,
                })
              }
            >
              초기화
            </Button>
          </div>
        </form>
        {searchError ? (
          <p className="form-error" role="alert">
            {searchError}
          </p>
        ) : null}
      </SectionCard>

      {events.isError ? (
        <QueryNotice
          error={events.error}
          hasData={Boolean(events.data)}
          label="VCS 이벤트"
          onRetry={() => void events.refetch()}
        />
      ) : null}

      <SectionCard title="VCS 이벤트" description="Webhook으로 수집한 커밋과 병합 요청입니다.">
        {!events.isPending && rows.length === 0 ? (
          <EmptyState
            title="수집된 VCS 이벤트가 없습니다."
            description="GitLab·GitHub webhook을 /vcs/webhook 으로 연결하면 프롬프트와 커밋을 이어서 볼 수 있습니다."
          />
        ) : (
          <DataTable
            caption="VCS 이벤트"
            columns={columns}
            data={rows}
            loading={events.isPending}
            getRowId={(row, index) => row.id || String(index)}
          />
        )}
      </SectionCard>
    </div>
  );
}
