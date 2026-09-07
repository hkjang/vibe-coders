import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Zap } from "lucide-react";
import { useCallback } from "react";

import "@/features/data/data.css";

import { InsightsTab } from "@/features/data/warehouse/InsightsTab";
import { MetricsTab } from "@/features/data/warehouse/MetricsTab";
import { PipelineTab } from "@/features/data/warehouse/PipelineTab";
import { dataQueryKeys } from "@/features/data/warehouse/use-warehouse-queries";
import {
  dwBuckets,
  dwDimensions,
  dwOrders,
  dwWindows,
  oneOf,
  positiveInt,
  warehouseTabs,
  type WarehouseTab,
} from "@/features/data/warehouse/warehouse-filters";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";

const tabLabels: Record<WarehouseTab, string> = {
  insights: "데이터 인사이트",
  pipeline: "데이터 파이프라인",
  metrics: "지표 카탈로그",
};

const maxConsistencyDays = 365;

export function WarehousePage(): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useTabParam<WarehouseTab>(warehouseTabs);
  const [params, update] = useSearchState();
  const canWrite = auth.user?.scopes.includes("admin:write") ?? false;

  const range = oneOf(params.get("window"), dwWindows, "30d");
  const bucket = oneOf(params.get("bucket"), dwBuckets, "day");
  const dimension = oneOf(params.get("dimension"), dwDimensions, "model");
  const order = oneOf(params.get("order_by"), dwOrders, "cost");
  const days = positiveInt(params.get("days"), 30, maxConsistencyDays);
  const eventTable = params.get("table") ?? "";

  const onFilterChange = useCallback(
    (updates: Record<string, string | undefined>): void => update(updates),
    [update],
  );

  const refreshCache = useMutationFeedback({
    mutate: () => apiClient.request(endpoints.domains.data.warehouse.refreshCache),
    invalidates: [dataQueryKeys.warehouse],
    successMessage: "분석 캐시를 비웠습니다. 최신 값으로 다시 조회합니다.",
    errorMessage: "캐시를 새로고침하지 못했습니다.",
  });

  const refreshAll = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["data"] });
  };

  return (
    <div className="page-stack">
      <PageHeader
        title="데이터 웨어하우스"
        description="ClickHouse 분석 지표, 적재 파이프라인 상태, 표준 지표 정의를 한 화면에서 확인합니다."
        legacyHref="/admin#/dwdashboard"
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => refreshCache.mutate(undefined)}
              disabled={!canWrite || refreshCache.isPending}
              title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
            >
              <Zap aria-hidden="true" /> 분석 캐시 비우기
            </Button>
            <Button variant="primary" onClick={refreshAll}>
              <RefreshCw aria-hidden="true" /> 새로고침
            </Button>
          </>
        }
      />

      <Tabs
        ariaLabel="데이터 웨어하우스 화면"
        items={warehouseTabs.map((id) => ({ id, label: tabLabels[id] }))}
        onChange={setTab}
        panelIdPrefix="warehouse"
        value={tab}
      />

      {tab === "insights" ? (
        <TabPanel id="insights" panelIdPrefix="warehouse">
          <InsightsTab
            bucket={bucket}
            dimension={dimension}
            onFilterChange={onFilterChange}
            order={order}
            range={range}
          />
        </TabPanel>
      ) : null}
      {tab === "pipeline" ? (
        <TabPanel id="pipeline" panelIdPrefix="warehouse">
          <PipelineTab
            canWrite={canWrite}
            days={days}
            eventTable={eventTable}
            onFilterChange={onFilterChange}
          />
        </TabPanel>
      ) : null}
      {tab === "metrics" ? (
        <TabPanel id="metrics" panelIdPrefix="warehouse">
          <MetricsTab canWrite={canWrite} />
        </TabPanel>
      ) : null}
    </div>
  );
}
