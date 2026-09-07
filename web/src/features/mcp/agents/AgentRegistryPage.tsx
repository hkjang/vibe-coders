import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { useAuth } from "@/app/auth/AuthProvider";
import "@/features/mcp/mcp.css";
import { AgentPerformanceTab } from "@/features/mcp/agents/AgentPerformanceTab";
import { AgentRoutesTab } from "@/features/mcp/agents/AgentRoutesTab";
import { VcsEventsTab } from "@/features/mcp/agents/VcsEventsTab";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { useTabParam } from "@/shared/hooks/use-tab-param";

const tabIds = ["routes", "performance", "vcs"] as const;
type AgentTabId = (typeof tabIds)[number];

const tabItems: ReadonlyArray<{ id: AgentTabId; label: string }> = [
  { id: "routes", label: "에이전트 라우트" },
  { id: "performance", label: "에이전트 성능" },
  { id: "vcs", label: "VCS 이벤트" },
];

export const agentWriteScope = "admin:write";

export function AgentRegistryPage(): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useTabParam<AgentTabId>([...tabIds]);
  const canWrite = auth.user?.scopes.includes(agentWriteScope) ?? false;

  return (
    <div className="page-stack">
      <PageHeader
        title="에이전트"
        description="가상 모델 경로(에이전트 라우트), 코딩 에이전트 성능과 VCS 연계 이벤트를 관리합니다."
        legacyHref="/admin#/agents"
        actions={
          <Button
            variant="primary"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["agents"] })}
          >
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      {canWrite ? null : (
        <InlineNotice tone="info" title="읽기 전용으로 열려 있습니다.">
          에이전트 라우트 생성·수정·삭제에는 <code>{agentWriteScope}</code> 권한이 필요합니다.
        </InlineNotice>
      )}

      <Tabs ariaLabel="에이전트 화면" items={tabItems} onChange={setTab} panelIdPrefix="agents" value={tab} />

      <TabPanel id={tab} panelIdPrefix="agents">
        {tab === "routes" ? <AgentRoutesTab canWrite={canWrite} /> : null}
        {tab === "performance" ? <AgentPerformanceTab /> : null}
        {tab === "vcs" ? <VcsEventsTab /> : null}
      </TabPanel>
    </div>
  );
}
