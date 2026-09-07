import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { AllocationTab } from "@/features/finops/overview/AllocationTab";
import { BudgetTab } from "@/features/finops/overview/BudgetTab";
import { ChargebackTab } from "@/features/finops/overview/ChargebackTab";
import { OverviewTab } from "@/features/finops/overview/OverviewTab";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { Tabs, TabPanel, type TabItem } from "@/shared/components/ui/Tabs";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import "@/features/finops/finops.css";

const tabs = [
  { id: "overview", label: "비용 대시보드" },
  { id: "allocation", label: "비용 배부" },
  { id: "chargeback", label: "배부 팩" },
  { id: "budget", label: "예산·이상 신호" },
] as const satisfies ReadonlyArray<TabItem<string>>;

type TabId = (typeof tabs)[number]["id"];

const tabIds = tabs.map((tab) => tab.id) as readonly TabId[];

export function FinopsPage(): React.JSX.Element {
  const [active, setActive] = useTabParam<TabId>(tabIds);
  const queryClient = useQueryClient();

  return (
    <div className="page-stack">
      <PageHeader
        title="비용 관리"
        description="조직 전체 비용, 차원별 배부, 월별 정산 팩과 예산 소진 예측을 확인합니다."
        legacyHref="/admin#/billing"
        readOnly
        status="preview"
        actions={
          <Button
            variant="primary"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["finops"] })}
          >
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      <Tabs
        ariaLabel="비용 관리 화면"
        items={tabs}
        onChange={setActive}
        panelIdPrefix="finops"
        value={active}
      />

      <TabPanel id={active} panelIdPrefix="finops">
        {active === "overview" ? <OverviewTab /> : null}
        {active === "allocation" ? <AllocationTab /> : null}
        {active === "chargeback" ? <ChargebackTab /> : null}
        {active === "budget" ? <BudgetTab /> : null}
      </TabPanel>
    </div>
  );
}
