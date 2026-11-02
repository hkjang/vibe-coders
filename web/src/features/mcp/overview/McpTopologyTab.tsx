import { useMemo, useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { QueryNotice } from "@/features/mcp/mcp-ui";
import type { McpTopologyNode } from "@/shared/api/domains/mcp.schemas";
import { ErrorState, LoadingState, PermissionDenied } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { DataTable } from "@/shared/data-table/DataTable";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { pageFromParam, useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { filterTopology, topologyKind, topologyModel, topologyState } from "./mcp-topology-model";
import { useMcpTopology } from "./use-mcp-topology";
import { TopologyGraph } from "./TopologyGraph";
import { TopologyDetails } from "./TopologyDetails";
import "./mcp-topology.css";

const column = createDataTableColumnHelper<McpTopologyNode>();
const columns = [
  column.accessor((node) => node.label || node.id, { id: "name", header: "이름" }),
  column.accessor((node) => topologyKind(node.kind), { id: "kind", header: "종류" }),
  column.accessor((node) => topologyState(node.status), { id: "status", header: "사용 상태" }),
  column.accessor((node) => topologyState(node.decision), { id: "decision", header: "현재 정책 판단" }),
] as ReadonlyArray<DataTableColumn<McpTopologyNode>>;
const kindOptions = ["", "gateway", "upstream", "tool", "prompt", "resource"].map((value) => ({
  value,
  label: value ? topologyKind(value) : "모든 종류",
}));
const stateOptions = [
  "",
  "enabled",
  "disabled",
  "allow",
  "warn",
  "block",
  "approval_required",
  "not_in_allowlist",
].map((value) => ({ value, label: value ? topologyState(value) : "모든 상태" }));

export default function McpTopologyTab() {
  const owner = useFeatureReadOwner(
    "mcp.overview",
    "mcp-topology",
    ["observability:read"],
    "observability:read",
  );
  if (!owner.readable) return <PermissionDenied permission="observability:read" />;
  if (owner.denied)
    return (
      <ErrorState
        title="연결 구조 조회 권한을 다시 확인하세요."
        message="이전 연결 구조와 선택 내용을 표시하지 않습니다."
        onRetry={owner.restart}
        showLegacy={false}
      />
    );
  return <TopologyContent key={owner.id} owner={owner} />;
}

function TopologyContent({ owner }: { owner: FeatureReadOwner }) {
  const auth = useAuth();
  const [params, update] = useSearchState();
  const query = useMcpTopology(owner);
  const [error, setError] = useState("");
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const search = params.get("topology_q") ?? "";
  const selected = params.get("node") ?? "";
  const kind = params.get("kind") ?? "";
  const state = params.get("decision") ?? "";
  const safe = ![search, selected].some((value) => containsPotentialSecret(value, auth.credentialPrefixes));
  const model = useMemo(() => topologyModel(query.data ?? { nodes: [], edges: [] }), [query.data]);
  const nodes = filterTopology(query.data?.nodes ?? [], safe ? search : "", kind, state);
  const pageCount = Math.max(1, Math.ceil(nodes.length / 25));
  const page = Math.min(pageCount, pageFromParam(params.get("topology_page")));
  const selection = safe ? model.byId.get(selected) : undefined;
  const select = (id: string) => {
    if (containsPotentialSecret(id, auth.credentialPrefixes)) {
      setError(secretSearchMessage);
      return;
    }
    setError("");
    if (!selection && document.activeElement instanceof HTMLElement)
      returnFocusRef.current = document.activeElement;
    update({ node: id });
  };
  if (!safe)
    return (
      <ErrorState
        message={secretSearchMessage}
        onReset={() => update({ topology_q: undefined, node: undefined })}
        showLegacy={false}
      />
    );
  return (
    <div className="mcp-section-stack mcp-topology-explorer">
      <SectionCard
        title="MCP 연결 구조"
        description="게이트웨이와 등록 업스트림, 마지막으로 발견한 도구·프롬프트·리소스의 연결입니다."
        actions={
          <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
            {query.isFetching ? "갱신 중" : "연결 구조 새로고침"}
          </Button>
        }
      >
        <p>
          구성과 디스커버리 캐시를 별도로 읽은 결과입니다. 실시간 연결 상태·호출 흐름·에이전트 관계를 나타내지
          않습니다.
        </p>
        {query.isError ? (
          <QueryNotice
            error={query.error}
            hasData={Boolean(query.data)}
            label="MCP 연결 구조"
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {query.isPending ? <LoadingState label="연결 구조를 불러오는 중입니다." /> : null}
        {query.data ? (
          <p>
            수신한 노드 {formatNumber(query.data.nodes.length)}개 · 연결{" "}
            {formatNumber(query.data.edges.length)}개 · 마지막 정상 갱신{" "}
            <time dateTime={new Date(query.dataUpdatedAt).toISOString()}>
              {formatDateTime(new Date(query.dataUpdatedAt).toISOString())}
            </time>
          </p>
        ) : null}
        {model.missing.length ? (
          <InlineNotice tone="warning" title="일부 연결 대상을 확인할 수 없습니다.">
            <p>
              수신 목록에 없는 노드를 참조하는 연결 {model.missing.length}개가 있습니다. 선택한 노드의 연결
              목록에서 누락을 확인하고 새로고침하세요.
            </p>
          </InlineNotice>
        ) : null}
        {model.disconnected.length ? (
          <InlineNotice tone="info" title="게이트웨이 연결이 확인되지 않는 노드가 있습니다.">
            <p>
              {model.disconnected.length}개 노드에 도달하는 연결이 수신되지 않았습니다. 장애라고 단정할 수
              없습니다.
            </p>
          </InlineNotice>
        ) : null}
      </SectionCard>
      {query.data ? (
        <>
          <SectionCard
            title="연결 탐색"
            description="필터는 이번에 수신한 전체 노드에 적용합니다. 목록은 25개씩 표시하며 서버 페이지 조회가 아닙니다."
          >
            <form
              key={search}
              className="mcp-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                const value = String(new FormData(event.currentTarget).get("search") ?? "").trim();
                if (containsPotentialSecret(value, auth.credentialPrefixes)) {
                  setError(secretSearchMessage);
                  return;
                }
                setError("");
                update({ topology_q: value, topology_page: undefined });
              }}
            >
              <label htmlFor="mcp-topology-search">
                이름·노드 ID 검색
                <Input id="mcp-topology-search" name="search" defaultValue={search} />
              </label>
              <label htmlFor="mcp-topology-kind">
                종류
                <Select
                  id="mcp-topology-kind"
                  value={kind}
                  options={kindOptions}
                  onChange={(event) => update({ kind: event.target.value, topology_page: undefined })}
                />
              </label>
              <label htmlFor="mcp-topology-state">
                상태
                <Select
                  id="mcp-topology-state"
                  value={state}
                  options={stateOptions}
                  onChange={(event) => update({ decision: event.target.value, topology_page: undefined })}
                />
              </label>
              <Button type="submit">검색</Button>
              <Button
                type="reset"
                onClick={() => {
                  setError("");
                  update({
                    topology_q: undefined,
                    kind: undefined,
                    decision: undefined,
                    topology_page: undefined,
                  });
                }}
              >
                필터 초기화
              </Button>
            </form>
            {error ? (
              <p role="alert" className="form-error">
                {error}
              </p>
            ) : null}
            <p role="status">필터 결과 {formatNumber(nodes.length)}개</p>
            {nodes.length ? (
              <>
                <details className="mcp-topology-diagram" open={nodes.length <= 60}>
                  <summary>연결도 보기</summary>
                  <TopologyGraph
                    nodes={nodes}
                    edges={query.data.edges}
                    selected={selected}
                    onSelect={select}
                  />
                </details>
                <DataTable
                  caption="MCP 연결 노드"
                  columns={columns}
                  data={nodes.slice((page - 1) * 25, page * 25)}
                  getRowId={(node) => node.id}
                  getRowActionLabel={(node) => `${node.label || node.id} 목록 상세`}
                  onRowClick={(node) => select(node.id)}
                  pageIndex={page - 1}
                  pageCount={pageCount}
                  onPageChange={(next) => update({ topology_page: next + 1 })}
                />
              </>
            ) : (
              <EmptyState
                title={
                  query.data.nodes.length ? "조건에 맞는 노드가 없습니다." : "수신한 연결 노드가 없습니다."
                }
                description="필터를 초기화하거나 연결 구조를 다시 조회하세요."
              />
            )}
          </SectionCard>
          {selection ? (
            <Sheet
              open
              title="MCP 연결 상세"
              description="선택한 노드의 현재 구성과 서버가 반환한 연결입니다."
              returnFocusRef={returnFocusRef}
              onOpenChange={(open) => {
                if (!open) update({ node: undefined });
              }}
            >
              <TopologyDetails
                node={selection}
                model={model}
                onSelect={select}
                onClear={() => update({ node: undefined })}
              />
            </Sheet>
          ) : selected ? (
            <InlineNotice
              tone="warning"
              title="선택한 노드가 현재 목록에 없습니다."
              actions={<Button onClick={() => update({ node: undefined })}>선택 해제</Button>}
            >
              삭제되었거나 구성 조회 시점이 달라졌을 수 있습니다.
            </InlineNotice>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
