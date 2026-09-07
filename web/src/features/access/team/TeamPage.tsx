import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/app/auth/AuthProvider";
import { TeamDashboardTab } from "@/features/access/team/TeamDashboardTab";
import { TeamPortalTab } from "@/features/access/team/TeamPortalTab";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { TabPanel, Tabs, type TabItem } from "@/shared/components/ui/Tabs";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import "@/features/access/access.css";

const tabIds = ["dashboard", "portal"] as const;
type TabId = (typeof tabIds)[number];

const tabs: ReadonlyArray<TabItem<TabId>> = [
  { id: "dashboard", label: "팀 대시보드" },
  { id: "portal", label: "팀 포털" },
];

const teamNamePattern = /^[\w .:@+-]{1,120}$/u;

export function TeamPage(): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useTabParam<TabId>(tabIds);
  const [params, updateParams] = useSearchState();
  const scopes = auth.user?.scopes ?? [];
  const canReadTeam = scopes.includes("team:read");
  // `?team=` overrides the caller's own team, and the server only honours it for
  // operators holding `admin:read`.
  const canOverrideTeam = scopes.includes("admin:read");
  const requested = params.get("team") ?? "";
  const team = canOverrideTeam && teamNamePattern.test(requested) ? requested : "";

  return (
    <div className="page-stack">
      <PageHeader
        title="팀 대시보드"
        description="팀의 사용량, 비용, 위험 신호와 팀 포털을 확인합니다."
        status="preview"
        legacyHref="/admin#/team"
        actions={
          <Button
            variant="primary"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["team"] })}
          >
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      {!canReadTeam ? (
        <InlineNotice tone="warning" title="팀 조회 권한이 없습니다.">
          이 화면은 team:read 스코프가 있어야 데이터를 불러올 수 있습니다. 관리자에게 권한을 요청하세요.
        </InlineNotice>
      ) : null}

      {canOverrideTeam ? (
        <Toolbar label="팀 선택">
          <label className="access-toolbar-field">
            <span>팀</span>
            <Input
              defaultValue={team}
              key={team}
              placeholder="비우면 내 팀"
              onBlur={(event) => updateParams({ team: event.target.value.trim() || undefined })}
            />
          </label>
        </Toolbar>
      ) : null}

      <Tabs ariaLabel="팀 화면 영역" items={tabs} value={tab} onChange={setTab} panelIdPrefix="team" />

      {tab === "dashboard" ? (
        <TabPanel id="dashboard" panelIdPrefix="team">
          <TeamDashboardTab team={team} />
        </TabPanel>
      ) : null}
      {tab === "portal" ? (
        <TabPanel id="portal" panelIdPrefix="team">
          <TeamPortalTab team={team} />
        </TabPanel>
      ) : null}
    </div>
  );
}
