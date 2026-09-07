import { RefreshCw } from "lucide-react";
import { useCallback } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import "@/features/text2sql/text2sql.css";
import { Text2SqlAccessTab } from "@/features/text2sql/overview/Text2SqlAccessTab";
import { Text2SqlGoldenTab } from "@/features/text2sql/overview/Text2SqlGoldenTab";
import { Text2SqlOverviewTab } from "@/features/text2sql/overview/Text2SqlOverviewTab";
import { Text2SqlReportTab } from "@/features/text2sql/overview/Text2SqlReportTab";
import { Text2SqlRiskTab } from "@/features/text2sql/overview/Text2SqlRiskTab";
import { Text2SqlRuntimeTab } from "@/features/text2sql/overview/Text2SqlRuntimeTab";
import { Text2SqlSchemaTab } from "@/features/text2sql/overview/Text2SqlSchemaTab";
import { useText2SqlQueries, type Text2SqlTabId } from "@/features/text2sql/overview/use-text2sql-queries";
import { isAppError } from "@/shared/api/error";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { ErrorState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Select } from "@/shared/components/ui/Select";
import { TabPanel, Tabs, type TabItem } from "@/shared/components/ui/Tabs";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";

const tabs: ReadonlyArray<TabItem<Text2SqlTabId>> = [
  { id: "overview", label: "요약" },
  { id: "runtime", label: "런타임·연결" },
  { id: "schemas", label: "스키마·레지스트리" },
  { id: "access", label: "권한·용어" },
  { id: "risk", label: "위험·이상" },
  { id: "golden", label: "Golden Query" },
  { id: "reports", label: "리포트·인사이트" },
];
const tabIds = tabs.map((tab) => tab.id);

const windowOptions = [
  { value: "24h", label: "최근 24시간" },
  { value: "7d", label: "최근 7일" },
  { value: "30d", label: "최근 30일" },
];
const defaultWindow = "7d";

function windowLabel(value: string): string {
  return windowOptions.find((option) => option.value === value)?.label ?? value;
}

function minRiskFrom(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 50;
}

/**
 * Text2SQL operations console: the pipeline's schemas, permissions, connections,
 * risk queue and golden-query regression. Questions, generated SQL and rejection
 * reasons are shown on screen only — never written to the URL or to storage.
 */
export function Text2SqlPage(): React.JSX.Element {
  const auth = useAuth();
  const canWrite = auth.user?.scopes.includes("admin:write") ?? false;
  const [params, updateSearch] = useSearchState();
  const [tab, setTab] = useTabParam<Text2SqlTabId>(tabIds);
  const requestedWindow = params.get("window");
  const selectedWindow = windowOptions.some((option) => option.value === requestedWindow)
    ? (requestedWindow as string)
    : defaultWindow;
  const registrySchema = params.get("schema")?.trim() ?? "";
  const minRisk = minRiskFrom(params.get("min_risk"));

  const queries = useText2SqlQueries({ minRisk, registrySchema, tab, window: selectedWindow });
  const overview = queries.overview.data;
  const setRegistrySchema = useCallback(
    (schema: string): void => updateSearch({ schema: schema || undefined }),
    [updateSearch],
  );

  const refreshing =
    queries.overview.isFetching || queries.connections.isFetching || queries.killSwitch.isFetching;
  const refreshAll = (): void => {
    void Promise.all([
      queries.overview.refetch(),
      queries.connections.refetch(),
      queries.killSwitch.refetch(),
    ]);
  };

  if (queries.overview.isError && !overview) {
    return (
      <div className="page-stack">
        <PageHeader
          title="Text2SQL"
          status="legacy"
          description="자연어 질문을 읽기 전용 SQL로 변환하는 파이프라인을 운영합니다."
          legacyHref="/admin#/text2sql"
        />
        <ErrorState
          message={safeAppErrorMessage(queries.overview.error, "Text2SQL 현황을 불러오지 못했습니다.")}
          requestId={isAppError(queries.overview.error) ? queries.overview.error.requestId : undefined}
          onRetry={() => void queries.overview.refetch()}
          legacyHref="/admin#/text2sql"
        />
      </div>
    );
  }

  const killed = queries.killSwitch.data?.disabled ?? false;
  const connections = queries.connections.data?.connections ?? [];

  return (
    <div className="page-stack">
      <PageHeader
        title="Text2SQL"
        status="legacy"
        description="사용자는 vibe/text2sql-* 가상 모델을 호출하고, 게이트웨이가 SQL을 생성·검증하고 선택적으로 실행합니다."
        legacyHref="/admin#/text2sql"
        actions={
          <>
            {canWrite ? null : <Badge tone="info">읽기 전용</Badge>}
            <label className="t2s-inline-field">
              <span>조회 기간</span>
              <Select
                value={selectedWindow}
                options={windowOptions}
                onChange={(event) =>
                  updateSearch({
                    window: event.target.value === defaultWindow ? undefined : event.target.value,
                  })
                }
              />
            </label>
            <Button variant="primary" onClick={refreshAll} disabled={refreshing}>
              <RefreshCw aria-hidden="true" /> {refreshing ? "갱신 중" : "새로고침"}
            </Button>
          </>
        }
      />

      {killed ? (
        <InlineNotice tone="danger" title="Text2SQL이 전체 중지되어 있습니다.">
          모든 vibe/text2sql-* 요청이 SQL을 생성하지 않고 안전 메시지를 반환합니다. 런타임·연결 탭에서 해제할
          수 있습니다.
        </InlineNotice>
      ) : null}

      {queries.overview.isError && overview ? (
        <InlineNotice tone="warning" title="현황 갱신에 실패해 마지막 정상 데이터를 표시합니다.">
          {safeAppErrorMessage(queries.overview.error, "Text2SQL 현황을 갱신하지 못했습니다.")}
          <Button size="small" variant="secondary" onClick={() => void queries.overview.refetch()}>
            다시 시도
          </Button>
        </InlineNotice>
      ) : null}

      <Tabs
        ariaLabel="Text2SQL 영역"
        panelIdPrefix="text2sql"
        items={tabs}
        value={tab}
        onChange={(next) => setTab(next)}
      />

      {tab === "overview" ? (
        <TabPanel id="overview" panelIdPrefix="text2sql">
          <Text2SqlOverviewTab
            overview={overview}
            loading={queries.overview.isPending}
            windowLabel={windowLabel(selectedWindow)}
          />
        </TabPanel>
      ) : null}

      {tab === "runtime" ? (
        <TabPanel id="runtime" panelIdPrefix="text2sql">
          <Text2SqlRuntimeTab
            canWrite={canWrite}
            connections={connections}
            connectionsError={queries.connections.error}
            connectionsLoading={queries.connections.isPending}
            features={queries.features.data?.features ?? []}
            featuresError={queries.features.error}
            featuresLoading={queries.features.isPending}
            killSwitchDisabled={killed}
            onRefetchConnections={() => void queries.connections.refetch()}
            onRefetchFeatures={() => void queries.features.refetch()}
            profiles={overview?.db_profiles ?? []}
            profilesLoading={queries.overview.isPending}
          />
        </TabPanel>
      ) : null}

      {tab === "schemas" ? (
        <TabPanel id="schemas" panelIdPrefix="text2sql">
          <Text2SqlSchemaTab
            canWrite={canWrite}
            columns={queries.registry.data?.columns ?? []}
            connections={connections}
            onRegistrySchemaChange={setRegistrySchema}
            onRetryRegistry={() => void queries.registry.refetch()}
            registryError={queries.registry.error}
            registryLoading={registrySchema !== "" && queries.registry.isPending}
            registrySchema={registrySchema}
            schemas={overview?.schemas ?? []}
            schemasLoading={queries.overview.isPending}
            tables={queries.registry.data?.tables ?? []}
          />
        </TabPanel>
      ) : null}

      {tab === "access" ? (
        <TabPanel id="access" panelIdPrefix="text2sql">
          <Text2SqlAccessTab
            canWrite={canWrite}
            conflicts={queries.glossary.data?.conflicts ?? []}
            glossaryError={queries.glossary.error}
            glossaryLoading={queries.glossary.isPending}
            onRetryGlossary={() => void queries.glossary.refetch()}
            permissions={overview?.permissions ?? []}
            permissionsLoading={queries.overview.isPending}
            terms={queries.glossary.data?.terms ?? []}
          />
        </TabPanel>
      ) : null}

      {tab === "risk" ? (
        <TabPanel id="risk" panelIdPrefix="text2sql">
          <Text2SqlRiskTab
            anomalies={queries.anomalies.data}
            anomaliesError={queries.anomalies.error}
            anomaliesLoading={queries.anomalies.isPending}
            minRisk={minRisk}
            onMinRiskChange={(value) => updateSearch({ min_risk: value === 50 ? undefined : value })}
            onRetryAnomalies={() => void queries.anomalies.refetch()}
            onRetryRiskQueue={() => void queries.riskQueue.refetch()}
            queue={queries.riskQueue.data?.queue ?? []}
            riskQueueError={queries.riskQueue.error}
            riskQueueLoading={queries.riskQueue.isPending}
            windowLabel={windowLabel(selectedWindow)}
          />
        </TabPanel>
      ) : null}

      {tab === "golden" ? (
        <TabPanel id="golden" panelIdPrefix="text2sql">
          <Text2SqlGoldenTab
            canWrite={canWrite}
            golden={overview?.golden ?? []}
            loading={queries.overview.isPending}
          />
        </TabPanel>
      ) : null}

      {tab === "reports" ? (
        <TabPanel id="reports" panelIdPrefix="text2sql">
          <Text2SqlReportTab
            canWrite={canWrite}
            miners={queries.miners.data}
            minersError={queries.miners.error}
            minersLoading={queries.miners.isPending}
            onRetryMiners={() => void queries.miners.refetch()}
            onRetryReports={() => void queries.reports.refetch()}
            reports={queries.reports.data?.reports ?? []}
            reportsError={queries.reports.error}
            reportsLoading={queries.reports.isPending}
          />
        </TabPanel>
      ) : null}
    </div>
  );
}
