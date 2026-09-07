import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";

import { useAuth } from "@/app/auth/AuthProvider";
import { AuditTab } from "@/features/system/settings/AuditTab";
import { ChangeSetsTab } from "@/features/system/settings/ChangeSetsTab";
import { ConsoleRolloutTab } from "@/features/system/settings/ConsoleRolloutTab";
import { OperationsTab } from "@/features/system/settings/OperationsTab";
import { RuntimeSettingsTab } from "@/features/system/settings/RuntimeSettingsTab";
import { SsoTab } from "@/features/system/settings/SsoTab";
import { SystemErrorsTab } from "@/features/system/settings/SystemErrorsTab";
import "@/features/system/settings/system-settings.css";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { TabPanel, Tabs, type TabItem } from "@/shared/components/ui/Tabs";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";

const tabIds = ["runtime", "console", "operations", "changesets", "sso", "audit", "errors"] as const;
type TabId = (typeof tabIds)[number];

const tabItems: ReadonlyArray<TabItem<TabId>> = [
  { id: "runtime", label: "런타임 설정" },
  { id: "console", label: "콘솔 전환" },
  { id: "operations", label: "데이터·알림 운영" },
  { id: "changesets", label: "변경 세트" },
  { id: "sso", label: "SSO (Keycloak)" },
  { id: "audit", label: "변경 이력" },
  { id: "errors", label: "시스템 오류" },
];

/** Legacy settings panels that another console domain owns or that stay in Legacy. */
const delegatedPanels: ReadonlyArray<{ title: string; where: string; href: string; internal: boolean }> = [
  { title: "프록시 API 키", where: "사용자·접근 화면", href: "/app/access/users", internal: true },
  {
    title: "업스트림 공급자 · Provider SLO",
    where: "AI 공급자 화면",
    href: "/app/gateway/providers",
    internal: true,
  },
  { title: "로그인 계정 · 팀 (RBAC)", where: "사용자·접근 화면", href: "/app/access/users", internal: true },
  {
    title: "복잡도 기반 라우팅 규칙 · 라우팅 학습 추천",
    where: "라우팅 규칙 화면",
    href: "/app/routing/rules",
    internal: true,
  },
  { title: "AI 코딩 작업 템플릿", where: "프롬프트 자산 화면", href: "/app/prompts/library", internal: true },
  { title: "Knowledge Cache", where: "기존 관리자 화면", href: "/admin#/settings", internal: false },
];

export function SystemSettingsPage(): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useTabParam<TabId>(tabIds);
  const hasAdminWrite = auth.user?.scopes.includes("admin:write") ?? false;
  const showLegacy = canOpenLegacyAdmin(auth);

  return (
    <div className="page-stack">
      <PageHeader
        title="시스템 설정"
        status="preview"
        description="게이트웨이 런타임 설정, 신규 콘솔 전환 상태, 변경 이력과 운영 작업을 한 곳에서 관리합니다."
        legacyHref="/admin#/settings"
        actions={
          <>
            {hasAdminWrite ? null : <Badge tone="info">읽기 전용</Badge>}
            <Button
              variant="primary"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ["system"] })}
            >
              <RefreshCw aria-hidden="true" /> 새로고침
            </Button>
          </>
        }
      />

      {hasAdminWrite ? null : (
        <InlineNotice tone="info" title="변경 권한이 없습니다.">
          admin:write 권한이 없어 설정을 조회만 할 수 있습니다. 범주별 세부 권한이 부족하면 저장할 때 서버가
          알려 주는 사유가 그대로 표시됩니다.
        </InlineNotice>
      )}

      <Tabs
        ariaLabel="시스템 설정 영역"
        items={tabItems}
        onChange={setTab}
        panelIdPrefix="system-settings"
        value={tab}
      />

      <TabPanel id={tab} panelIdPrefix="system-settings">
        {tab === "runtime" ? <RuntimeSettingsTab hasAdminWrite={hasAdminWrite} /> : null}
        {tab === "console" ? <ConsoleRolloutTab hasAdminWrite={hasAdminWrite} /> : null}
        {tab === "operations" ? <OperationsTab hasAdminWrite={hasAdminWrite} /> : null}
        {tab === "changesets" ? <ChangeSetsTab hasAdminWrite={hasAdminWrite} /> : null}
        {tab === "sso" ? <SsoTab hasAdminWrite={hasAdminWrite} /> : null}
        {tab === "audit" ? <AuditTab /> : null}
        {tab === "errors" ? <SystemErrorsTab hasAdminWrite={hasAdminWrite} /> : null}
      </TabPanel>

      <SectionCard
        title="다른 화면에서 관리하는 설정"
        description="기존 설정 센터의 나머지 패널은 담당 화면으로 옮겨졌습니다."
      >
        <ul className="settings-delegated-list">
          {delegatedPanels.map((panel) => (
            <li key={panel.title}>
              <span>{panel.title}</span>
              {panel.internal || showLegacy ? (
                <a href={panel.href}>
                  {panel.where} 열기 <ExternalLink aria-hidden="true" />
                </a>
              ) : (
                <span className="settings-permission-note">{panel.where}에서 관리합니다.</span>
              )}
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
