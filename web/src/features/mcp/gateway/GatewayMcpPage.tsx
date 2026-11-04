import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QueryNotice } from "@/features/mcp/mcp-ui";
import "@/features/mcp/mcp.css";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { ErrorState, LoadingState, PermissionDenied } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { DataTable } from "@/shared/data-table/DataTable";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { ContractRegistry } from "./ContractRegistry";
import { toolColumns, publishedColumns } from "./gateway-columns";

export function GatewayMcpPage() {
  const owner = useFeatureReadOwner("mcp.gateway", "gateway-info");
  if (!owner.readable) return <PermissionDenied permission="admin:read" />;
  if (owner.denied)
    return (
      <ErrorState
        title="게이트웨이 MCP 조회 권한을 다시 확인하세요."
        message="이전 연결 정보를 표시하지 않습니다."
        onRetry={owner.restart}
        showLegacy={false}
      />
    );
  return <GatewayContent key={owner.id} owner={owner} />;
}
function GatewayContent({ owner }: { owner: FeatureReadOwner }) {
  const client = useQueryClient();
  const interval = useRefreshInterval();
  const info = useQuery({
    queryKey: featureOwnedKey(["mcp", "gateway", "info"], owner),
    gcTime: 0,
    retry: false,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(endpoints.domains.mcp.gateway.info, {
        signal,
        routeId: "mcp.gateway",
      });
      assertFeatureRead(owner, signal);
      return data;
    },
  });
  const data = info.data;
  return (
    <div className="page-stack">
      <PageHeader
        title="게이트웨이 MCP"
        description="게이트웨이가 제공하는 MCP 연결 정보와 도구 계약을 관리합니다."
        legacyHref="/admin#/gateway-mcp"
        actions={
          <Button onClick={() => void client.invalidateQueries({ queryKey: ["mcp", "gateway"] })}>
            새로고침
          </Button>
        }
      />
      {info.isError ? (
        <QueryNotice
          error={info.error}
          hasData={Boolean(data)}
          label="게이트웨이 MCP 정보"
          onRetry={() => void info.refetch()}
        />
      ) : null}
      {info.isPending ? (
        <LoadingState label="게이트웨이 MCP 정보를 불러오는 중입니다." />
      ) : data ? (
        <>
          <SectionCard title="연결 설정" description="외부 에이전트는 발급받은 프록시 API 키로 연결합니다.">
            <p>마지막 갱신 {formatDateTime(info.dataUpdatedAt)}</p>
            <KeyValueList
              items={[
                { label: "엔드포인트", value: data.endpoint, mono: true },
                { label: "프로토콜 버전", value: data.protocol_version },
                { label: "도구", value: formatNumber(data.tools.length) },
                { label: "리소스", value: formatNumber(data.resources.length) },
                { label: "프롬프트", value: formatNumber(data.prompts.length) },
              ]}
            />
            {data.endpoint === "/mcp/gateway" ? (
              <JsonBlock
                label="MCP 클라이언트 설정"
                value={{
                  mcpServers: {
                    "vibe-gateway": {
                      url: window.location.origin + data.endpoint,
                      headers: { Authorization: "Bearer <발급받은 프록시 API 키>" },
                    },
                  },
                }}
                maxHeight={220}
              />
            ) : (
              <p>연결 주소가 예상과 다릅니다. 기존 화면에서 서버 설정을 확인하세요.</p>
            )}
          </SectionCard>
          <SectionCard title="제공 도구" description="게이트웨이가 MCP로 노출하는 도구 목록입니다.">
            <DataTable
              caption="게이트웨이 MCP 도구"
              columns={toolColumns}
              data={data.tools}
              getRowId={(row) => row.name}
              emptyMessage="노출 중인 도구가 없습니다."
            />
          </SectionCard>
          <SectionCard
            title="게시된 도구 계약"
            description="게이트웨이 구현이 게시한 계약입니다. 아래 레지스트리 선언과 별개입니다."
          >
            <DataTable
              caption="게이트웨이 MCP 게시 계약"
              columns={publishedColumns}
              data={data.contracts}
              getRowId={(row) => row.name}
              emptyMessage="게시된 계약이 없습니다."
            />
          </SectionCard>
        </>
      ) : null}
      <ContractRegistry />
    </div>
  );
}
