import { useCallback } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { NarrativeTab } from "@/features/governance/reports/NarrativeTab";
import { ProductivityTab } from "@/features/governance/reports/ProductivityTab";
import {
  isReportWindow,
  reportWindowOptions,
  type ReportWindow,
} from "@/features/governance/reports/report-window";
import { ScorecardTab } from "@/features/governance/reports/ScorecardTab";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Select } from "@/shared/components/ui/Select";
import { TabPanel, Tabs, type TabItem } from "@/shared/components/ui/Tabs";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import "@/features/governance/reports/governance-reports.css";

const tabIds = ["scorecard", "narrative", "productivity"] as const;
type ReportTab = (typeof tabIds)[number];

const tabs: ReadonlyArray<TabItem<ReportTab>> = [
  { id: "scorecard", label: "팀 성숙도" },
  { id: "narrative", label: "운영 보고서" },
  { id: "productivity", label: "AI 업무성과" },
];

const defaultWindow: ReportWindow = "30d";

export function ReportsPage(): React.JSX.Element {
  const auth = useAuth();
  const refreshInterval = useRefreshInterval();
  const [tab, setTab] = useTabParam<ReportTab>(tabIds);
  const [params, updateParams] = useSearchState();
  const requestedWindow = params.get("window");
  const reportWindow = isReportWindow(requestedWindow) ? requestedWindow : defaultWindow;
  const canRead = auth.user?.scopes.includes("admin:read") ?? false;

  const changeWindow = useCallback(
    (value: string): void => {
      updateParams({ window: isReportWindow(value) && value !== defaultWindow ? value : undefined });
    },
    [updateParams],
  );

  return (
    <div className="page-stack">
      <PageHeader
        title="운영 리포트"
        description="팀 성숙도 스코어카드, 월간 운영 서술 보고서, AI 업무성과를 한 화면에서 확인합니다."
        legacyHref="/admin#/scorecard"
        status="preview"
      />

      {canRead ? null : (
        <InlineNotice tone="warning" title="읽기 권한이 없습니다.">
          이 화면의 리포트를 조회하고 내보내려면 admin:read 권한이 필요합니다. 관리자에게 권한을 요청하세요.
        </InlineNotice>
      )}

      <Toolbar label="리포트 조회 조건">
        <label className="gov-toolbar-field">
          조회 기간
          <Select
            value={reportWindow}
            onChange={(event) => changeWindow(event.currentTarget.value)}
            options={reportWindowOptions.map((option) => ({ ...option }))}
          />
        </label>
      </Toolbar>

      <Tabs
        ariaLabel="운영 리포트 탭"
        items={tabs}
        onChange={setTab}
        panelIdPrefix="governance-reports"
        value={tab}
      />

      <TabPanel id={tab} panelIdPrefix="governance-reports">
        {tab === "scorecard" ? (
          <ScorecardTab canExport={canRead} refetchInterval={refreshInterval} window={reportWindow} />
        ) : null}
        {tab === "narrative" ? (
          <NarrativeTab canExport={canRead} refetchInterval={refreshInterval} window={reportWindow} />
        ) : null}
        {tab === "productivity" ? (
          <ProductivityTab refetchInterval={refreshInterval} window={reportWindow} />
        ) : null}
      </TabPanel>
    </div>
  );
}
