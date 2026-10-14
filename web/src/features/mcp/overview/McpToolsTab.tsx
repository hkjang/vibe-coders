import { useMemo, useState } from "react";
import { QueryNotice } from "@/features/mcp/mcp-ui";
import { decisionLabel, riskLabel } from "@/features/mcp/mcp-utils";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import type { McpToolQuery } from "@/shared/api/domains/mcp";
import type { McpToolStat } from "@/shared/api/domains/mcp.schemas";
import { ErrorState, PermissionDenied } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { DataTable } from "@/shared/data-table/DataTable";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatNumber } from "@/shared/utils/format";
import { toolColumns, serverColumns, catalogColumns, trustColumns, type ToolRow } from "./mcp-tool-columns";
import { useMcpToolData } from "./use-mcp-tool-data";
import { ToolRiskDialog } from "./ToolRiskDialog";

const riskOptions = [
  { value: "", label: "전체 위험도" },
  { value: "low", label: riskLabel("low") },
  { value: "medium", label: riskLabel("medium") },
  { value: "high", label: riskLabel("high") },
  { value: "critical", label: riskLabel("critical") },
];
const actionOptions = [
  { value: "", label: "전체 조치" },
  { value: "allow", label: decisionLabel("allow") },
  { value: "require_approval", label: decisionLabel("require_approval") },
  { value: "block", label: decisionLabel("block") },
];
const configuredOptions = [
  { value: "", label: "전체" },
  { value: "true", label: "설정됨" },
  { value: "false", label: "기본값" },
];

export function McpToolsTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const owner = useFeatureReadOwner(
    "mcp.overview",
    "mcp-tools",
    ["observability:read"],
    "observability:read",
  );
  if (!owner.readable) return <PermissionDenied permission="observability:read" />;
  if (owner.denied)
    return (
      <ErrorState
        title="MCP 도구 조회 권한을 다시 확인하세요."
        message="이전 조회 결과와 편집 내용을 표시하지 않습니다."
        onRetry={owner.restart}
        showLegacy={false}
      />
    );
  return <McpToolsContent key={owner.id} owner={owner} scopeCanWrite={canWrite} />;
}
function McpToolsContent({ owner, scopeCanWrite }: { owner: FeatureReadOwner; scopeCanWrite: boolean }) {
  const mutationAccess = useFeatureMutationAccess(
    ["mcp.overview"],
    scopeCanWrite,
    "MCP 관리 권한(mcp:admin)이 필요합니다.",
  );
  const canWrite = mutationAccess.allowed;
  const refetchInterval = useRefreshInterval();
  const [params, updateParams] = useSearchState();
  const [searchError, setSearchError] = useState<string | undefined>();
  const [editing, setEditing] = useState<ToolRow | undefined>();
  const { remember: rememberTrigger, returnFocusRef: editTriggerRef } = useReturnFocus();

  const server = params.get("server") ?? "";
  const tool = params.get("tool") ?? "";
  const risk = params.get("risk_level") ?? "";
  const action = params.get("action") ?? "";
  const configured = params.get("configured") ?? "";
  const mcpOnly = params.get("mcp_only") === "1";

  const query: McpToolQuery = {
    ...(server ? { server } : {}),
    ...(tool ? { tool } : {}),
    ...(risk ? { risk_level: risk } : {}),
    ...(action ? { action } : {}),
    ...(configured === "true" || configured === "false" ? { configured } : {}),
    ...(mcpOnly ? { mcp_only: "1" as const } : {}),
    limit: 200,
  };

  const { tools, servers, catalog, trust } = useMcpToolData(owner, query, refetchInterval);

  const toolRows = useMemo<ToolRow[]>(() => {
    const stats = new Map<string, McpToolStat>();
    for (const stat of tools.data?.tools ?? []) {
      stats.set(JSON.stringify([stat.server_label, stat.tool_name]), stat);
    }
    return (tools.data?.tool_risk ?? []).map((risky) => {
      const stat = stats.get(JSON.stringify([risky.server_label, risky.tool_name]));
      return {
        ...risky,
        calls: stat?.calls ?? 0,
        errors: stat?.errors ?? 0,
        errorRate: stat?.error_rate ?? 0,
        lastSeen: stat?.last_seen ?? "",
      };
    });
  }, [tools.data?.tool_risk, tools.data?.tools]);

  const applyFilters = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextServer = String(data.get("server") ?? "").trim();
    const nextTool = String(data.get("tool") ?? "").trim();
    if (containsPotentialSecret(nextServer) || containsPotentialSecret(nextTool)) {
      setSearchError(secretSearchMessage);
      return;
    }
    setSearchError(undefined);
    updateParams({
      server: nextServer || undefined,
      tool: nextTool || undefined,
      risk_level: String(data.get("risk_level") ?? "") || undefined,
      action: String(data.get("action") ?? "") || undefined,
      configured: String(data.get("configured") ?? "") || undefined,
      mcp_only: data.get("mcp_only") === "on" ? "1" : undefined,
    });
  };

  return (
    <div className="mcp-section-stack">
      <SectionCard title="도구 필터" description="서버·도구 이름과 위험 등급으로 목록을 좁힙니다.">
        <form className="mcp-filter-grid" onSubmit={applyFilters}>
          <label htmlFor="mcp-tools-server">
            서버 라벨
            <Input id="mcp-tools-server" name="server" defaultValue={server} key={`server-${server}`} />
          </label>
          <label htmlFor="mcp-tools-tool">
            도구 이름
            <Input id="mcp-tools-tool" name="tool" defaultValue={tool} key={`tool-${tool}`} />
          </label>
          <label htmlFor="mcp-tools-risk">
            위험도
            <Select
              id="mcp-tools-risk"
              name="risk_level"
              defaultValue={risk}
              options={riskOptions}
              key={`risk-${risk}`}
            />
          </label>
          <label htmlFor="mcp-tools-action">
            조치
            <Select
              id="mcp-tools-action"
              name="action"
              defaultValue={action}
              options={actionOptions}
              key={`action-${action}`}
            />
          </label>
          <label htmlFor="mcp-tools-configured">
            설정 상태
            <Select
              id="mcp-tools-configured"
              name="configured"
              defaultValue={configured}
              options={configuredOptions}
              key={`configured-${configured}`}
            />
          </label>
          <label htmlFor="mcp-tools-mcponly" className="checkbox">
            <input id="mcp-tools-mcponly" name="mcp_only" type="checkbox" defaultChecked={mcpOnly} />
            <span className="checkbox-copy">
              <span>MCP 도구만</span>
            </span>
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
                  server: undefined,
                  tool: undefined,
                  risk_level: undefined,
                  action: undefined,
                  configured: undefined,
                  mcp_only: undefined,
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

      {tools.isError ? (
        <QueryNotice
          error={tools.error}
          hasData={Boolean(tools.data)}
          label="도구 위험 등급"
          onRetry={() => void tools.refetch()}
        />
      ) : null}

      <SectionCard title="도구 위험 등급" description="MCP 도구별 위험 등급, 조치와 최근 호출 통계입니다.">
        {!tools.isPending && !tools.isError && toolRows.length === 0 ? (
          <EmptyState
            title="조건에 맞는 도구가 없습니다."
            description="MCP 도구가 한 번이라도 호출되면 여기에 나타납니다. 필터를 초기화해 보세요."
          />
        ) : (
          <DataTable
            caption="MCP 도구 위험 등급"
            columns={toolColumns(canWrite, (row, trigger) => {
              rememberTrigger(trigger);
              setEditing(row);
            })}
            data={toolRows}
            loading={tools.isPending}
            error={tools.isError && !tools.data ? "도구 위험 등급을 불러오지 못했습니다." : undefined}
            onRetry={() => void tools.refetch()}
            getRowId={(row) => JSON.stringify([row.server_label, row.tool_name])}
          />
        )}
      </SectionCard>

      <SectionCard title="서버별 사용량" description="도구를 노출한 서버 라벨 기준 호출과 오류 통계입니다.">
        {servers.isError ? (
          <QueryNotice
            error={servers.error}
            hasData={Boolean(servers.data)}
            label="서버 사용량"
            onRetry={() => void servers.refetch()}
          />
        ) : null}
        <DataTable
          caption="MCP 서버별 사용량"
          columns={serverColumns}
          data={servers.data?.servers ?? []}
          loading={servers.isPending}
          error={servers.isError && !servers.data ? "서버 사용량을 불러오지 못했습니다." : undefined}
          onRetry={() => void servers.refetch()}
          getRowId={(row) => row.server_label}
          emptyMessage="집계된 서버가 없습니다."
        />
      </SectionCard>

      <SectionCard
        title="도구 카탈로그"
        description="최근 24시간 안에 새로 나타났거나 오랫동안 호출되지 않은 도구를 표시합니다."
        actions={
          catalog.data ? (
            <span className="mcp-note">신규 {formatNumber(catalog.data.new_count)}개</span>
          ) : null
        }
      >
        {catalog.isError ? (
          <QueryNotice
            error={catalog.error}
            hasData={Boolean(catalog.data)}
            label="도구 카탈로그"
            onRetry={() => void catalog.refetch()}
          />
        ) : null}
        <DataTable
          caption="MCP 도구 카탈로그"
          columns={catalogColumns}
          data={catalog.data?.catalog ?? []}
          loading={catalog.isPending}
          error={catalog.isError && !catalog.data ? "도구 카탈로그을 불러오지 못했습니다." : undefined}
          onRetry={() => void catalog.refetch()}
          getRowId={(row) => JSON.stringify([row.server_label, row.tool_name])}
          emptyMessage="관측된 도구가 없습니다."
        />
      </SectionCard>

      <SectionCard title="도구 신뢰 점수" description="최근 30일 오류율과 위험 등급으로 계산한 점수입니다.">
        {trust.isError ? (
          <QueryNotice
            error={trust.error}
            hasData={Boolean(trust.data)}
            label="도구 신뢰 점수"
            onRetry={() => void trust.refetch()}
          />
        ) : null}
        <DataTable
          caption="MCP 도구 신뢰 점수"
          columns={trustColumns}
          data={trust.data?.tools ?? []}
          loading={trust.isPending}
          error={trust.isError && !trust.data ? "도구 신뢰 점수을 불러오지 못했습니다." : undefined}
          onRetry={() => void trust.refetch()}
          getRowId={(row) => row.ref}
          emptyMessage="점수를 계산할 호출 기록이 없습니다."
        />
      </SectionCard>

      {editing ? (
        <ToolRiskDialog
          baseline={editing}
          owner={owner}
          canWrite={scopeCanWrite}
          onClose={() => setEditing(undefined)}
          returnFocusRef={editTriggerRef}
        />
      ) : null}
    </div>
  );
}
