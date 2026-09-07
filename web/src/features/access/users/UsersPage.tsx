import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/app/auth/AuthProvider";
import { ApiKeysTab } from "@/features/access/users/ApiKeysTab";
import { IpsTab } from "@/features/access/users/IpsTab";
import { QuotasTab } from "@/features/access/users/QuotasTab";
import { RolesTab } from "@/features/access/users/RolesTab";
import { TeamsTab } from "@/features/access/users/TeamsTab";
import { UsersTab } from "@/features/access/users/UsersTab";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { TabPanel, Tabs, type TabItem } from "@/shared/components/ui/Tabs";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import "@/features/access/access.css";

const tabIds = ["users", "teams", "keys", "ips", "quotas", "roles"] as const;
type TabId = (typeof tabIds)[number];

const tabs: ReadonlyArray<TabItem<TabId>> = [
  { id: "users", label: "사용자" },
  { id: "teams", label: "팀" },
  { id: "keys", label: "API 키" },
  { id: "ips", label: "IP" },
  { id: "quotas", label: "할당량·예산" },
  { id: "roles", label: "역할" },
];

export function UsersPage(): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useTabParam<TabId>(tabIds);
  const scopes = auth.user?.scopes ?? [];
  const role = auth.user?.role ?? "";
  // `team_admin` may write to users, teams and API keys without `admin:write`;
  // the server re-checks that the target belongs to their own team.
  const canWrite = scopes.includes("admin:write") || role === "team_admin";
  const isSuperAdmin = role === "super_admin";
  const writeDeniedReason =
    "변경 권한(admin:write)이 없어 읽기만 할 수 있습니다. 관리자에게 권한을 요청하세요.";

  return (
    <div className="page-stack">
      <PageHeader
        title="사용자와 팀"
        description="로그인 계정, 팀, API 키, IP 사용량, 할당량·예산과 역할을 한 곳에서 관리합니다."
        status="legacy"
        legacyHref="/admin#/users"
        actions={
          <Button
            variant="primary"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["access"] })}
          >
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      <Tabs ariaLabel="접근 관리 영역" items={tabs} value={tab} onChange={setTab} panelIdPrefix="access" />

      {tab === "users" ? (
        <TabPanel id="users" panelIdPrefix="access">
          <UsersTab canWrite={canWrite} writeDeniedReason={writeDeniedReason} />
        </TabPanel>
      ) : null}
      {tab === "teams" ? (
        <TabPanel id="teams" panelIdPrefix="access">
          <TeamsTab canWrite={canWrite} writeDeniedReason={writeDeniedReason} />
        </TabPanel>
      ) : null}
      {tab === "keys" ? (
        <TabPanel id="keys" panelIdPrefix="access">
          <ApiKeysTab canWrite={canWrite} isSuperAdmin={isSuperAdmin} writeDeniedReason={writeDeniedReason} />
        </TabPanel>
      ) : null}
      {tab === "ips" ? (
        <TabPanel id="ips" panelIdPrefix="access">
          <IpsTab />
        </TabPanel>
      ) : null}
      {tab === "quotas" ? (
        <TabPanel id="quotas" panelIdPrefix="access">
          <QuotasTab canWrite={canWrite} writeDeniedReason={writeDeniedReason} />
        </TabPanel>
      ) : null}
      {tab === "roles" ? (
        <TabPanel id="roles" panelIdPrefix="access">
          <RolesTab canWrite={canWrite} writeDeniedReason={writeDeniedReason} />
        </TabPanel>
      ) : null}
    </div>
  );
}
