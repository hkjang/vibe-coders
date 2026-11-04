import { Navigate, useLocation } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { AlertRulesSection } from "@/features/governance/policies/AlertRulesSection";
import { CostGuardSection } from "@/features/governance/policies/CostGuardSection";
import { GovernanceEventsSection } from "@/features/governance/policies/GovernanceEventsSection";
import { KillSwitchSection } from "@/features/governance/policies/KillSwitchSection";
import { ModelSunsetTab } from "@/features/governance/policies/ModelSunsetTab";
import { PolicyEngineSection } from "@/features/governance/policies/PolicyEngineSection";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { PoliciesLayout } from "./PoliciesLayout";
import { policyTabs } from "./policy-navigation";

export function PoliciesPage(): React.JSX.Element {
  const auth = useAuth();
  const location = useLocation();
  const [tab] = useTabParam(policyTabs);
  const canWrite = auth.user?.scopes.includes("admin:write") ?? false;
  if (tab === "advisor")
    return <Navigate replace to={{ pathname: "/governance/policies/advisor", search: location.search }} />;

  return (
    <PoliciesLayout tab={tab} canWrite={canWrite}>
      {tab === "safety" ? (
        <div className="page-stack">
          <KillSwitchSection canWrite={canWrite} />
          <PolicyEngineSection canWrite={canWrite} />
          <GovernanceEventsSection canWrite={canWrite} />
          <AlertRulesSection canWrite={canWrite} />
          <CostGuardSection canWrite={canWrite} />
          <InlineNotice tone="info" title="비용 예측">
            모델별 비용 예측은 비용(FinOps) 화면이나 기존 화면(/admin#/safety)에서 실행합니다.
          </InlineNotice>
        </div>
      ) : (
        <ModelSunsetTab canWrite={canWrite} />
      )}
    </PoliciesLayout>
  );
}
