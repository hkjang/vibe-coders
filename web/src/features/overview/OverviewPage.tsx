import { LegacyLink } from "@/shared/components/ui/LegacyLink";

import { useIsFetching, useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";

import { useAuth } from "@/app/auth/AuthProvider";
import { FirstRunChecklist } from "@/features/overview/FirstRunChecklist";
import { OverviewCapabilitiesTab } from "@/features/overview/OverviewCapabilitiesTab";
import { OverviewStatusTab } from "@/features/overview/OverviewStatusTab";
import { OverviewUsageTab } from "@/features/overview/OverviewUsageTab";
import { OverviewTrendPanel } from "@/features/overview/OverviewTrendPanel";
import { OverviewQueryFeedback } from "@/features/overview/OverviewQueryFeedback";
import { overviewReadDenied } from "@/features/overview/overview-query-state";
import { healthStatusLabels } from "@/config/ui-labels";
import { FeatureReadOnlyBadge, MigrationEyebrow } from "@/shared/components/page/MigrationStatus";
import { refreshIntervalMs } from "@/features/health/health-utils";
import { TimeRangePicker, UpdatedTime } from "@/features/health/health-ui";
import { useHealthRange } from "@/features/health/use-health-range";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { usePreferences } from "@/shared/stores/preferences";
import "@/features/overview/overview.css";

const tabIds = ["status", "usage", "capabilities"] as const;
type TabId = (typeof tabIds)[number];

const tabQueryFilter = {
  predicate: (query: Query): boolean =>
    query.queryKey[0] === "overview" ||
    (query.queryKey[0] === "admin" && query.queryKey[1] === "capabilities"),
};

export function OverviewPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const tabFetching = useIsFetching(tabQueryFilter);
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const interval = refreshIntervalMs(refreshInterval);
  const auth = useAuth();
  const [range, setRange] = useHealthRange();
  const [tab, setTab] = useTabParam<TabId>(tabIds, "status");
  const showLegacyAdmin = canOpenLegacyAdmin(auth);
  const canReadRouting =
    auth.mode === "open" || auth.mode === "legacy" || Boolean(auth.user?.scopes.includes("routing:read"));

  const health = useQuery({
    queryKey: ["gateway", "health"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.health, {
        signal,
        routeId: "overview.health",
      }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const statsQuery = useQuery({
    queryKey: ["admin", "stats"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.stats, {
        signal,
        routeId: "overview.traffic",
      }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const routingQuery = useQuery({
    queryKey: ["admin", "routing", "health", range],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.routing.health, {
        query: { window: range, threshold: 70 },
        signal,
        routeId: "overview.routing",
      }),
    enabled: canReadRouting,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const operationsQuery = useQuery({
    queryKey: ["admin", "ops", "risk"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.ops.risk, {
        signal,
        routeId: "overview.operations",
      }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });

  const stats = {
    ...statsQuery,
    data: overviewReadDenied(statsQuery.error) ? undefined : statsQuery.data,
    dataUpdatedAt: overviewReadDenied(statsQuery.error) ? 0 : statsQuery.dataUpdatedAt,
  };
  const routing = {
    ...routingQuery,
    data: overviewReadDenied(routingQuery.error) || !canReadRouting ? undefined : routingQuery.data,
    dataUpdatedAt: overviewReadDenied(routingQuery.error) || !canReadRouting ? 0 : routingQuery.dataUpdatedAt,
  };
  const operations = {
    ...operationsQuery,
    data: overviewReadDenied(operationsQuery.error) ? undefined : operationsQuery.data,
    dataUpdatedAt: overviewReadDenied(operationsQuery.error) ? 0 : operationsQuery.dataUpdatedAt,
  };

  const routingNeedsAttention =
    canReadRouting &&
    (Boolean(routing.data?.degraded.length) ||
      Boolean(routing.data?.alerts.some((alert) => alert.severity !== "info")) ||
      Boolean(routing.data?.breakers.states.some((state) => state.phase !== "closed")));
  const opsStatus = operations.data?.status;
  const opsRisk = operations.data?.risk;
  const operationsNeedAttention =
    Boolean(opsRisk?.factors.length) ||
    Boolean(opsStatus?.partial_failures?.length) ||
    Boolean(opsStatus?.logging.dropped) ||
    opsStatus?.disk.available === false;
  const secondaryFailure = stats.isError || (canReadRouting && routing.isError) || operations.isError;
  const checking =
    health.isPending || stats.isPending || (canReadRouting && routing.isPending) || operations.isPending;
  const degraded =
    health.isError ||
    secondaryFailure ||
    routingNeedsAttention ||
    operationsNeedAttention ||
    (opsRisk?.tier !== undefined && opsRisk.tier !== "low");
  const overallState =
    health.isError && !health.data
      ? "disconnected"
      : checking
        ? "checking"
        : health.data?.status === "ok"
          ? degraded
            ? "degraded"
            : "healthy"
          : "checking";
  const overallStatus = healthStatusLabels[overallState];
  const overallTone =
    overallState === "healthy"
      ? "success"
      : overallState === "checking"
        ? "muted"
        : overallState === "degraded"
          ? "warning"
          : "danger";
  const refreshing =
    health.isFetching ||
    stats.isFetching ||
    (canReadRouting && routing.isFetching) ||
    operations.isFetching ||
    tabFetching > 0;

  const refreshAll = (): void => {
    void Promise.all([
      health.refetch(),
      stats.refetch(),
      operations.refetch(),
      queryClient.refetchQueries({ ...tabQueryFilter, type: "active" }),
      ...(canReadRouting ? [routing.refetch()] : []),
    ]);
  };

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <MigrationEyebrow fallbackStatus="preview_read_only" />
          <h1>운영 개요</h1>
          <p>게이트웨이 상태, 트래픽, 비용과 위험 신호를 한 화면에서 확인합니다.</p>
        </div>
        <div className="page-actions">
          <FeatureReadOnlyBadge readOnly />
          <Badge tone={overallTone}>{overallStatus}</Badge>
          {showLegacyAdmin ? (
            <LegacyLink className="button button-secondary button-default" href="/admin#/dashboard">
              기존 화면에서 열기
            </LegacyLink>
          ) : null}
          <Button onClick={refreshAll} disabled={refreshing}>
            <RefreshCw aria-hidden="true" /> 전체 새로고침
          </Button>
        </div>
      </header>

      <div className="health-page-toolbar">
        <TimeRangePicker value={range} onChange={setRange} />
        <div className="status-meta">
          <span>백엔드 {auth.backendVersion}</span>
          {health.dataUpdatedAt > 0 ? (
            <UpdatedTime timestamp={health.dataUpdatedAt} label="게이트웨이 응답" />
          ) : null}
        </div>
      </div>

      <section className="status-banner" aria-labelledby="gateway-health-title">
        <div className="status-icon" data-status={overallState}>
          <Activity aria-hidden="true" />
        </div>
        <div>
          <h2 id="gateway-health-title">게이트웨이 상태</h2>
          {health.isPending ? <p>게이트웨이 연결을 확인하는 중입니다.</p> : null}
          {health.data && !health.isError ? (
            <p>
              게이트웨이 상태 확인 요청에 응답했으며, 운영 신호는 <strong>{overallStatus}</strong> 상태입니다.
            </p>
          ) : null}
          {health.isError ? (
            <p>
              {health.data
                ? "새 상태 갱신에 실패해 마지막 정상 응답을 표시합니다."
                : "게이트웨이 상태 확인에 실패했습니다. 각 영역의 재시도를 이용하세요."}
            </p>
          ) : null}
        </div>
        <Badge tone={overallTone}>{overallStatus}</Badge>
      </section>

      <Tabs
        ariaLabel="운영 개요 화면"
        panelIdPrefix="overview"
        items={[
          { id: "status", label: "운영 상태" },
          { id: "usage", label: "사용 현황" },
          { id: "capabilities", label: "기능 맵" },
        ]}
        value={tab}
        onChange={setTab}
      />

      <TabPanel id={tab} panelIdPrefix="overview">
        {tab === "status" ? <FirstRunChecklist stats={stats.data} status={opsStatus} /> : null}
        {tab === "usage" ? (
          <div className="overview-usage-stack">
            <OverviewTrendPanel />
            <OverviewQueryFeedback
              label="누적 사용량"
              error={stats.error}
              fetching={stats.isFetching}
              updatedAt={stats.dataUpdatedAt}
              retry={() => void stats.refetch()}
            />
            {stats.isPending ? (
              <p role="status">누적 사용량을 불러오는 중입니다.</p>
            ) : stats.data && !overviewReadDenied(stats.error) ? (
              <OverviewUsageTab stats={stats.data} />
            ) : null}
          </div>
        ) : null}
        {tab === "capabilities" ? <OverviewCapabilitiesTab /> : null}
        {tab === "status" ? (
          <OverviewStatusTab
            stats={stats}
            routing={routing}
            operations={operations}
            range={range}
            canReadRouting={canReadRouting}
            routingNeedsAttention={routingNeedsAttention}
            operationsNeedAttention={operationsNeedAttention}
          />
        ) : null}
      </TabPanel>
    </div>
  );
}
