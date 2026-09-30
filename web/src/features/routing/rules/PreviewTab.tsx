import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { routingCostGuardQueryKey } from "@/features/routing/rules/routing-shared";
import { QueryFailureNotice } from "@/features/routing/rules/routing-ui";
import { apiClient } from "@/shared/api/client";
import type { CostGuard } from "@/shared/api/domains/cost-guard";
import { endpoints } from "@/shared/api/endpoints";
import { CostGuardContractNotice } from "@/shared/components/form/CostGuardContractNotice";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { RoutingPreviewCard } from "./RoutingPreviewCard";
import { CostPredictionCard } from "./CostPredictionCard";
import {
  confirmedCostGuard,
  formatCostGuardThreshold,
  supportsCostGuardContract,
} from "@/shared/utils/cost-guard";

export function PreviewTab({ canPredict }: { canPredict: boolean }): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const costGuard = useQuery({
    queryKey: routingCostGuardQueryKey,
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.routing.costGuard, { signal, routeId: "routing.rules" }),
    retry: false,
    gcTime: 0,
    refetchOnMount: "always",
  });
  const costGuardState = useSyncExternalStore(
    useCallback((listener) => queryClient.getQueryCache().subscribe(listener), [queryClient]),
    useCallback(() => queryClient.getQueryState<CostGuard>(routingCostGuardQueryKey), [queryClient]),
  );
  const confirmedGuard = supportsCostGuardContract(auth.backendVersion)
    ? confirmedCostGuard(costGuardState)
    : undefined;

  return (
    <div className="routing-panel-stack">
      <RoutingPreviewCard />
      <CostPredictionCard canPredict={canPredict}>
        <CostGuardContractNotice />
        {costGuard.isError ? (
          <QueryFailureNotice
            error={costGuard.error}
            hasData={false}
            label="비용 보호 설정"
            onRetry={() => void costGuard.refetch()}
          />
        ) : null}
        <KeyValueList
          items={[
            {
              label: "예상 비용 보호",
              value: confirmedGuard ? (
                confirmedGuard.enabled && confirmedGuard.threshold_krw > 0 ? (
                  <Badge tone="success">사용 중</Badge>
                ) : (
                  <Badge tone="muted">제한 없음</Badge>
                )
              ) : (
                "설정 미확인"
              ),
            },
            {
              label: "요청당 임계값",
              value: confirmedGuard
                ? formatCostGuardThreshold(confirmedGuard.threshold_krw)
                : "확인되지 않음",
            },
          ]}
        />
        <Button size="small" disabled={costGuard.isFetching} onClick={() => void costGuard.refetch()}>
          비용 보호 설정 새로고침
        </Button>
        <p className="routing-meta">
          비용 보호 설정 변경은 정책 및 거버넌스 화면에서 합니다. 사용을 끄거나 임계값이 0이면 이 예상 비용
          검사로 제한하지 않습니다.
        </p>
      </CostPredictionCard>
    </div>
  );
}
