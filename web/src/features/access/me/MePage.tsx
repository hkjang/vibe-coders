import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/app/auth/AuthProvider";
import { MeHomeTab } from "@/features/access/me/MeHomeTab";
import { MeKeysTab } from "@/features/access/me/MeKeysTab";
import { MeRequestsTab } from "@/features/access/me/MeRequestsTab";
import { MeSkillsTab } from "@/features/access/me/MeSkillsTab";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { TabPanel, Tabs, type TabItem } from "@/shared/components/ui/Tabs";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import "@/features/access/access.css";

const tabIds = ["home", "requests", "skills", "keys"] as const;
type TabId = (typeof tabIds)[number];

const tabs: ReadonlyArray<TabItem<TabId>> = [
  { id: "home", label: "내 홈" },
  { id: "requests", label: "요청·영수증" },
  { id: "skills", label: "Skill·추천" },
  { id: "keys", label: "내 키·연결" },
];

export function MePage(): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useTabParam<TabId>(tabIds);
  const name = auth.user?.name || auth.user?.email || "";

  return (
    <div className="page-stack">
      <PageHeader
        title="내 홈"
        description={
          name
            ? `${name} 님의 사용량, 요청 영수증, API 키와 연결 상태를 확인합니다.`
            : "내 사용량, 요청 영수증, API 키와 연결 상태를 확인합니다."
        }
        status="preview"
        legacyHref="/admin#/me"
        actions={
          <Button variant="primary" onClick={() => void queryClient.invalidateQueries({ queryKey: ["me"] })}>
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      <Tabs ariaLabel="내 홈 영역" items={tabs} value={tab} onChange={setTab} panelIdPrefix="me" />

      {tab === "home" ? (
        <TabPanel id="home" panelIdPrefix="me">
          <MeHomeTab />
        </TabPanel>
      ) : null}
      {tab === "requests" ? (
        <TabPanel id="requests" panelIdPrefix="me">
          <MeRequestsTab />
        </TabPanel>
      ) : null}
      {tab === "skills" ? (
        <TabPanel id="skills" panelIdPrefix="me">
          <MeSkillsTab />
        </TabPanel>
      ) : null}
      {tab === "keys" ? (
        <TabPanel id="keys" panelIdPrefix="me">
          <MeKeysTab />
        </TabPanel>
      ) : null}
    </div>
  );
}
