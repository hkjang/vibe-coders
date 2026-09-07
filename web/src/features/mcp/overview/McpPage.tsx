import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/app/auth/AuthProvider";
import "@/features/mcp/mcp.css";
import { McpOverviewTab } from "@/features/mcp/overview/McpOverviewTab";
import { McpPolicyTab } from "@/features/mcp/overview/McpPolicyTab";
import { McpRequestsTab } from "@/features/mcp/overview/McpRequestsTab";
import { McpToolsTab } from "@/features/mcp/overview/McpToolsTab";
import { McpUpstreamsTab } from "@/features/mcp/overview/McpUpstreamsTab";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Tabs, TabPanel } from "@/shared/components/ui/Tabs";
import { useTabParam } from "@/shared/hooks/use-tab-param";

const tabIds = ["overview", "upstreams", "tools", "policy", "requests"] as const;
type McpTabId = (typeof tabIds)[number];

const tabItems: ReadonlyArray<{ id: McpTabId; label: string }> = [
  { id: "overview", label: "개요" },
  { id: "upstreams", label: "업스트림" },
  { id: "tools", label: "도구" },
  { id: "policy", label: "정책" },
  { id: "requests", label: "요청 로그" },
];

export const mcpWriteScope = "mcp:admin";

export function McpPage(): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useTabParam<McpTabId>([...tabIds]);
  const canWrite = auth.user?.scopes.includes(mcpWriteScope) ?? false;

  return (
    <div className="page-stack">
      <PageHeader
        status="legacy"
        title="MCP 운영"
        description="MCP 업스트림 연결, 노출 도구, 서버 정책과 최근 MCP 호출을 한 화면에서 관리합니다."
        legacyHref="/admin#/mcp"
        actions={
          <Button variant="primary" onClick={() => void queryClient.invalidateQueries({ queryKey: ["mcp"] })}>
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      {canWrite ? null : (
        <InlineNotice tone="info" title="읽기 전용으로 열려 있습니다.">
          업스트림 등록·정책 변경 등 조작에는 <code>{mcpWriteScope}</code> 권한이 필요합니다. 조회는 그대로
          가능합니다.
        </InlineNotice>
      )}

      <Tabs ariaLabel="MCP 화면" items={tabItems} onChange={setTab} panelIdPrefix="mcp" value={tab} />

      <TabPanel id={tab} panelIdPrefix="mcp">
        {tab === "overview" ? <McpOverviewTab canWrite={canWrite} /> : null}
        {tab === "upstreams" ? <McpUpstreamsTab canWrite={canWrite} /> : null}
        {tab === "tools" ? <McpToolsTab canWrite={canWrite} /> : null}
        {tab === "policy" ? <McpPolicyTab canWrite={canWrite} /> : null}
        {tab === "requests" ? <McpRequestsTab /> : null}
      </TabPanel>
    </div>
  );
}
