import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { useAuth } from "@/app/auth/AuthProvider";
import { AnomalyTab } from "@/features/security/overview/AnomalyTab";
import { AuditTab } from "@/features/security/overview/AuditTab";
import { PrivacyLedgerTab } from "@/features/security/overview/PrivacyLedgerTab";
import { SecretEventsTab } from "@/features/security/overview/SecretEventsTab";
import { SecurityDashboardTab } from "@/features/security/overview/SecurityDashboardTab";
import {
  isSecurityWindow,
  securityTabIds,
  securityTabs,
  securityWindowLabels,
  type SecurityTabId,
} from "@/features/security/overview/security-overview";
import { securityWindows } from "@/shared/api/domains/security";
import { FormField } from "@/shared/components/form/FormField";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { Select } from "@/shared/components/ui/Select";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";

export function SecurityOverviewPage(): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const refreshInterval = useRefreshInterval();
  const [tab, setTab] = useTabParam<SecurityTabId>(securityTabIds);
  const [params, updateSearch] = useSearchState();
  const requestedWindow = params.get("window");
  const range = isSecurityWindow(requestedWindow) ? requestedWindow : "7d";

  const scopes = auth.user?.scopes ?? [];
  const has = (scope: string): boolean => scopes.includes(scope);
  const showWindow = tab === "overview" || tab === "secrets";

  return (
    <div className="page-stack">
      <PageHeader
        title="보안"
        status="legacy"
        readOnly
        description="정책 위반, 비밀정보 탐지, 인증 이벤트와 데이터 전송 원장을 한곳에서 확인합니다."
        legacyHref="/admin#/security"
        actions={
          <Button
            variant="primary"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["security"] })}
          >
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      <div className="page-tabs">
        <Tabs
          ariaLabel="보안 화면 탭"
          items={securityTabs.map((item) => ({ id: item.id, label: item.label }))}
          onChange={setTab}
          panelIdPrefix="security"
          value={tab}
        />

        {showWindow ? (
          <FormField label="조회 구간">
            {(control) => (
              <Select
                {...control}
                value={range}
                onChange={(event) => updateSearch({ window: event.target.value })}
              >
                {securityWindows.map((value) => (
                  <option key={value} value={value}>
                    {securityWindowLabels[value]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        ) : null}

        <TabPanel id={tab} panelIdPrefix="security" className="page-stack">
          {tab === "overview" ? (
            <SecurityDashboardTab
              canRead={has("security:read")}
              range={range}
              refreshInterval={refreshInterval}
            />
          ) : null}
          {tab === "secrets" ? (
            <SecretEventsTab canRead={has("security:read")} range={range} refreshInterval={refreshInterval} />
          ) : null}
          {tab === "anomalies" ? (
            <AnomalyTab canRead={has("costs:read")} refreshInterval={refreshInterval} />
          ) : null}
          {tab === "audit" ? (
            <AuditTab canRead={has("admin:read")} refreshInterval={refreshInterval} />
          ) : null}
          {tab === "privacy" ? (
            <PrivacyLedgerTab canRead={has("admin:read")} refreshInterval={refreshInterval} />
          ) : null}
        </TabPanel>
      </div>
    </div>
  );
}
