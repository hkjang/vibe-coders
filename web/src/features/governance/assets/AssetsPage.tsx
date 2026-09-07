import { useCallback } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { PersonalizationTab } from "@/features/governance/assets/PersonalizationTab";
import { SbomTab } from "@/features/governance/assets/SbomTab";
import { isSbomType } from "@/features/governance/assets/sbom-types";
import {
  isReportWindow,
  reportWindowOptions,
  type ReportWindow,
} from "@/features/governance/reports/report-window";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Select } from "@/shared/components/ui/Select";
import { TabPanel, Tabs, type TabItem } from "@/shared/components/ui/Tabs";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { containsPotentialSecret } from "@/shared/security/secrets";
import "@/features/governance/reports/governance-reports.css";

const tabIds = ["sbom", "personalization"] as const;
type AssetTab = (typeof tabIds)[number];

const tabs: ReadonlyArray<TabItem<AssetTab>> = [
  { id: "sbom", label: "AI 자산 SBOM" },
  { id: "personalization", label: "개인화 프로필" },
];

const defaultWindow: ReportWindow = "30d";

export function AssetsPage(): React.JSX.Element {
  const auth = useAuth();
  const refreshInterval = useRefreshInterval();
  const [tab, setTab] = useTabParam<AssetTab>(tabIds);
  const [params, updateParams] = useSearchState();
  const requestedWindow = params.get("window");
  const reportWindow = isReportWindow(requestedWindow) ? requestedWindow : defaultWindow;
  const requestedType = params.get("type") ?? "";
  const assetType = isSbomType(requestedType) ? requestedType : "";
  const requestedUser = params.get("user")?.trim() ?? "";
  // A user id is an opaque identifier; never let a pasted credential become a lookup.
  const selectedUser = containsPotentialSecret(requestedUser) ? "" : requestedUser;
  const canRead = auth.user?.scopes.includes("admin:read") ?? false;

  const changeWindow = useCallback(
    (value: string): void => {
      updateParams({ window: isReportWindow(value) && value !== defaultWindow ? value : undefined });
    },
    [updateParams],
  );
  const changeType = useCallback(
    (value: string): void => updateParams({ type: isSbomType(value) ? value : undefined }),
    [updateParams],
  );
  const selectUser = useCallback(
    (value: string): void => updateParams({ user: value || undefined }),
    [updateParams],
  );

  return (
    <div className="page-stack">
      <PageHeader
        title="AI 자산"
        description="게이트웨이가 관리하는 AI 자산의 소유권 명세(SBOM)와 사용자별 개인화 프로필을 확인합니다."
        legacyHref="/admin#/sbom"
        status="preview"
      />

      {canRead ? null : (
        <InlineNotice tone="warning" title="읽기 권한이 없습니다.">
          AI 자산 명세와 개인화 프로필을 조회하려면 admin:read 권한이 필요합니다. 관리자에게 권한을
          요청하세요.
        </InlineNotice>
      )}

      <Tabs
        ariaLabel="AI 자산 탭"
        items={tabs}
        onChange={setTab}
        panelIdPrefix="governance-assets"
        value={tab}
      />

      {tab === "personalization" ? (
        <Toolbar label="개인화 조회 조건">
          <label className="gov-toolbar-field">
            조회 기간
            <Select
              value={reportWindow}
              onChange={(event) => changeWindow(event.currentTarget.value)}
              options={reportWindowOptions.map((option) => ({ ...option }))}
            />
          </label>
        </Toolbar>
      ) : null}

      <TabPanel id={tab} panelIdPrefix="governance-assets">
        {tab === "sbom" ? (
          <SbomTab
            canExport={canRead}
            onTypeChange={changeType}
            refetchInterval={refreshInterval}
            type={assetType}
          />
        ) : null}
        {tab === "personalization" ? (
          <PersonalizationTab
            onSelectUser={selectUser}
            refetchInterval={refreshInterval}
            selectedUser={selectedUser}
            window={reportWindow}
          />
        ) : null}
      </TabPanel>
    </div>
  );
}
