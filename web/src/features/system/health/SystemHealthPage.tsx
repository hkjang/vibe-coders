import { legacyRoutes } from "@/config/legacy-route-map";
import { useMemo } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useAuth } from "@/app/auth/AuthProvider";
import { uiLabels } from "@/config/ui-labels";
import { MigrationEyebrow } from "@/shared/components/page/MigrationStatus";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { FeatureLegacyLink } from "@/shared/components/ui/FeatureLegacyLink";
import { TabPanel, Tabs, type TabItem } from "@/shared/components/ui/Tabs";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { SystemRefreshContext } from "./system-refresh-context";
import { systemQueryMarker } from "./use-system-health-query";
import { SystemSnapshotTab } from "./SystemSnapshotTab";
import { OpsHomeTab } from "./OpsHomeTab";
import { OpsWorkersTab } from "./OpsWorkersTab";
import { IndexHealthTab } from "./IndexHealthTab";
import "./ops-home.css";

const tabIds = ["status", "ops", "workers", "indexes"] as const;
type TabId = (typeof tabIds)[number];
const tabs: ReadonlyArray<TabItem<TabId>> = [
  { id: "status", label: "상태" },
  { id: "ops", label: "운영 홈" },
  { id: "workers", label: "백그라운드 작업·배포 점검" },
  { id: "indexes", label: "인덱스" },
];

/** A new principal never inherits a preflight request, SQL search or open dialog. */
export function SystemHealthPage(): React.JSX.Element {
  const owner = useFeatureReadOwner("system.health", "system-health-workspace");
  if (!owner.readable)
    return (
      <InlineNotice tone="warning" title="시스템 상태 조회 권한을 확인하세요.">
        현재 계정의 admin:read 권한과 기능 사용 범위를 확인하세요.
      </InlineNotice>
    );
  return <SystemHealthWorkspace key={owner.id} />;
}
function SystemHealthWorkspace(): React.JSX.Element {
  const auth = useAuth();
  const [tab, setTab] = useTabParam<TabId>(tabIds);
  const refreshers = useMemo(() => new Set<() => void>(), []);
  const refreshing = useIsFetching({ predicate: (query) => query.queryKey.at(-2) === systemQueryMarker }) > 0;
  return (
    <SystemRefreshContext.Provider value={refreshers}>
      <div className="page-stack system-health-workspace">
        <header className="page-header">
          <div>
            <MigrationEyebrow fallbackStatus="preview_read_only" />
            <h1>시스템 상태</h1>
            <p>운영 위험, 장애 후보, 백그라운드 작업과 데이터베이스 구성을 확인합니다.</p>
          </div>
          <div className="page-actions">
            <Badge tone="info">{uiLabels.readOnly}</Badge>
            {canOpenLegacyAdmin(auth) ? (
              <FeatureLegacyLink
                featureId="system.health"
                className="button button-secondary button-default"
                href={legacyRoutes.operations}
              >
                기존 화면에서 열기
              </FeatureLegacyLink>
            ) : null}
            <Button disabled={refreshing} onClick={() => refreshers.forEach((refresh) => refresh())}>
              <RefreshCw aria-hidden="true" />
              새로고침
            </Button>
          </div>
        </header>
        <Tabs
          ariaLabel="시스템 상태 영역"
          items={tabs}
          value={tab}
          onChange={setTab}
          panelIdPrefix="system-health"
        />
        <TabPanel key={tab} id={tab} panelIdPrefix="system-health">
          {tab === "status" ? (
            <SystemSnapshotTab />
          ) : tab === "ops" ? (
            <OpsHomeTab />
          ) : tab === "workers" ? (
            <OpsWorkersTab />
          ) : (
            <IndexHealthTab />
          )}
        </TabPanel>
      </div>
    </SystemRefreshContext.Provider>
  );
}
