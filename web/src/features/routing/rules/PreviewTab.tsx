import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, useSyncExternalStore } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { predictScopeMessage, routingCostGuardQueryKey } from "@/features/routing/rules/routing-shared";
import { QueryFailureNotice } from "@/features/routing/rules/routing-ui";
import { apiClient } from "@/shared/api/client";
import type { RoutingCostEstimate } from "@/shared/api/domains/routing";
import type { CostGuard } from "@/shared/api/domains/cost-guard";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { CostGuardContractNotice } from "@/shared/components/form/CostGuardContractNotice";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { RoutingPreviewCard } from "./RoutingPreviewCard";
import { formatKRW, formatNumber } from "@/shared/utils/format";
import {
  confirmedCostGuard,
  formatCostGuardThreshold,
  supportsCostGuardContract,
} from "@/shared/utils/cost-guard";

interface RequestState {
  error?: { message: string; requestId?: string };
  pending: boolean;
}

export function PreviewTab({ canPredict }: { canPredict: boolean }): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [predictModel, setPredictModel] = useState("");
  const [inputTokens, setInputTokens] = useState("1000");
  const [maxTokens, setMaxTokens] = useState("600");
  const [estimate, setEstimate] = useState<RoutingCostEstimate>();
  const [predictState, setPredictState] = useState<RequestState>({ pending: false });

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

  const runPredict = async (): Promise<void> => {
    if (predictModel.trim() === "") return;
    setPredictState({ pending: true });
    try {
      const result = await apiClient.request(endpoints.domains.routing.costPredict, {
        body: {
          model: predictModel.trim(),
          input_tokens: Number(inputTokens) || 0,
          max_tokens: Number(maxTokens) || 0,
        },
      });
      setEstimate(result);
      setPredictState({ pending: false });
    } catch (cause) {
      setEstimate(undefined);
      setPredictState({
        pending: false,
        error: {
          message: safeAppErrorMessage(cause, "비용을 예측하지 못했습니다."),
          requestId: isAppError(cause) ? cause.requestId : undefined,
        },
      });
    }
  };

  return (
    <div className="routing-panel-stack">
      <RoutingPreviewCard />

      <SectionCard
        title="비용 예측 가드"
        description="호출 전에 예상 비용을 계산합니다. 비용 가드 임계값을 넘을 요청을 미리 걸러낼 수 있습니다."
        actions={
          <Button
            variant="primary"
            disabled={!canPredict || predictState.pending || predictModel.trim() === ""}
            title={canPredict ? undefined : predictScopeMessage}
            onClick={() => void runPredict()}
          >
            {predictState.pending ? "계산 중" : "비용 예측"}
          </Button>
        }
      >
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
        {canPredict ? null : (
          <InlineNotice tone="info" title="읽기 전용">
            {predictScopeMessage}
          </InlineNotice>
        )}
        <div className="routing-form">
          <FormField label="모델" required>
            {(control) => (
              <Input
                {...control}
                value={predictModel}
                placeholder="gpt-4.1"
                onChange={(event) => setPredictModel(event.target.value)}
              />
            )}
          </FormField>
          <FormField label="입력 토큰">
            {(control) => (
              <Input
                {...control}
                type="number"
                min={0}
                value={inputTokens}
                onChange={(event) => setInputTokens(event.target.value)}
              />
            )}
          </FormField>
          <FormField label="최대 출력 토큰">
            {(control) => (
              <Input
                {...control}
                type="number"
                min={0}
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
              />
            )}
          </FormField>
        </div>
        {predictState.error ? (
          <InlineNotice tone="danger" title="비용을 예측하지 못했습니다.">
            {predictState.error.message}
            {predictState.error.requestId ? ` 요청 ID: ${predictState.error.requestId}` : ""}
          </InlineNotice>
        ) : null}
        {estimate ? (
          <KeyValueList
            items={[
              { label: "모델", value: estimate.model, mono: true },
              { label: "예상 입력 토큰", value: formatNumber(estimate.input_tokens) },
              { label: "예상 출력 토큰", value: formatNumber(estimate.output_tokens) },
              { label: "예상 비용", value: formatKRW(estimate.cost_krw) },
              { label: "예상 지연", value: `${formatNumber(estimate.latency_ms)}ms` },
              { label: "가격표 적용", value: estimate.priced ? "적용됨" : "가격표 없음" },
              { label: "산정 기준", value: estimate.basis },
            ]}
          />
        ) : null}
      </SectionCard>
    </div>
  );
}
