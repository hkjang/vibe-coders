import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { DecisionsTab } from "@/features/routing/rules/DecisionsTab";
import { FailoverTab } from "@/features/routing/rules/FailoverTab";
import { HealthTab } from "@/features/routing/rules/HealthTab";
import { LearningTab } from "@/features/routing/rules/LearningTab";
import { PreviewTab } from "@/features/routing/rules/PreviewTab";
import { RulesTab } from "@/features/routing/rules/RulesTab";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { Tabs, TabPanel, type TabItem } from "@/shared/components/ui/Tabs";
import "@/features/routing/routing.css";

const basePath = "/routing/rules";

const tabs = [
  { id: "rules", label: "라우팅 규칙" },
  { id: "preview", label: "미리보기" },
  { id: "decisions", label: "결정 이력" },
  { id: "failover", label: "장애 전환" },
  { id: "learning", label: "학습 엔진" },
  { id: "health", label: "상태·차단기" },
] as const satisfies ReadonlyArray<TabItem<string>>;

type TabId = (typeof tabs)[number]["id"];

function tabFromPath(pathname: string): TabId {
  const rest = pathname.startsWith(basePath) ? pathname.slice(basePath.length).replace(/^\/+/u, "") : "";
  const segment = rest.split("/")[0] ?? "";
  return tabs.some((tab) => tab.id === segment) ? (segment as TabId) : "rules";
}

export function RoutingPage(): React.JSX.Element {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const active = tabFromPath(location.pathname);
  const canWrite = auth.user?.scopes.includes("routing:write") ?? false;
  const canPredict = auth.user?.scopes.includes("admin:write") ?? false;

  return (
    <div className="page-stack">
      <PageHeader
        title="라우팅"
        description="복잡도 기반 규칙, 라우팅 미리보기, 결정 이력, 장애 전환과 회로 차단기를 한 곳에서 운영합니다."
        legacyHref="/admin#/routing"
        readOnly={!canWrite}
        status="preview"
        actions={
          <Button
            variant="primary"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["routing"] })}
          >
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      <Tabs
        ariaLabel="라우팅 화면"
        items={tabs}
        onChange={(id) => {
          void navigate(id === "rules" ? basePath : `${basePath}/${id}`);
        }}
        panelIdPrefix="routing"
        value={active}
      />

      <TabPanel id={active} panelIdPrefix="routing">
        {active === "rules" ? <RulesTab canWrite={canWrite} /> : null}
        {active === "preview" ? <PreviewTab canPredict={canPredict} /> : null}
        {active === "decisions" ? <DecisionsTab /> : null}
        {active === "failover" ? <FailoverTab canWrite={canWrite} /> : null}
        {active === "learning" ? <LearningTab canWrite={canWrite} /> : null}
        {active === "health" ? <HealthTab canWrite={canWrite} /> : null}
      </TabPanel>
    </div>
  );
}
