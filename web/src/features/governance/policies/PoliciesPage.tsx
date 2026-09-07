import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { useAuth } from "@/app/auth/AuthProvider";
import { AlertRulesSection } from "@/features/governance/policies/AlertRulesSection";
import { GovernanceEventsSection } from "@/features/governance/policies/GovernanceEventsSection";
import { KillSwitchSection } from "@/features/governance/policies/KillSwitchSection";
import { ModelSunsetTab } from "@/features/governance/policies/ModelSunsetTab";
import { PolicyAdvisorTab } from "@/features/governance/policies/PolicyAdvisorTab";
import { PolicyEngineSection } from "@/features/governance/policies/PolicyEngineSection";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import "@/features/governance/policies/policies.css";

const tabIds = ["safety", "sunset", "advisor"] as const;
type TabId = (typeof tabIds)[number];

const tabItems = [
  { id: "safety" as const, label: "안전 정책" },
  { id: "sunset" as const, label: "모델 일몰" },
  { id: "advisor" as const, label: "정책 어드바이저" },
];

export function PoliciesPage(): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useTabParam<TabId>(tabIds);
  const canWrite = auth.user?.scopes.includes("admin:write") ?? false;

  return (
    <div className="page-stack">
      <PageHeader
        title="정책 및 거버넌스"
        status="legacy"
        description="긴급 정지, AI 정책 엔진, 승인 큐와 알림 규칙, 모델 일몰과 정책 추천을 관리합니다."
        legacyHref="/admin#/safety"
        actions={
          <Button
            variant="primary"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["governance"] })}
          >
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      {!canWrite ? (
        <InlineNotice tone="info" title="읽기 전용으로 열려 있습니다.">
          긴급 정지, 정책 저장, 승인 처리에는 admin:write 권한이 필요합니다. 조회는 그대로 사용할 수 있습니다.
        </InlineNotice>
      ) : null}

      <Tabs
        ariaLabel="정책 및 거버넌스 화면"
        items={tabItems}
        value={tab}
        onChange={setTab}
        panelIdPrefix="governance-policies"
      />

      {tab === "safety" ? (
        <TabPanel id="safety" panelIdPrefix="governance-policies">
          <div className="page-stack">
            <KillSwitchSection canWrite={canWrite} />
            <PolicyEngineSection canWrite={canWrite} />
            <GovernanceEventsSection canWrite={canWrite} />
            <AlertRulesSection canWrite={canWrite} />
            <InlineNotice tone="warning" title="이 화면에서 제공하지 않는 기능">
              비용 가드 설정·비용 예측은 저장 API가 공개 규격(OpenAPI)에 없어 이식하지 못했습니다. 기존
              화면(/admin#/safety)에서 처리하세요.
            </InlineNotice>
          </div>
        </TabPanel>
      ) : null}
      {tab === "sunset" ? (
        <TabPanel id="sunset" panelIdPrefix="governance-policies">
          <ModelSunsetTab canWrite={canWrite} />
        </TabPanel>
      ) : null}
      {tab === "advisor" ? (
        <TabPanel id="advisor" panelIdPrefix="governance-policies">
          <PolicyAdvisorTab canWrite={canWrite} />
        </TabPanel>
      ) : null}
    </div>
  );
}
