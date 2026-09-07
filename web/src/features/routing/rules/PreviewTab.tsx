import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { predictScopeMessage, routingCostGuardQueryKey } from "@/features/routing/rules/routing-shared";
import { QueryFailureNotice } from "@/features/routing/rules/routing-ui";
import { apiClient } from "@/shared/api/client";
import type { RoutingCostEstimate, RoutingPreview } from "@/shared/api/domains/routing";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatKRW, formatNumber } from "@/shared/utils/format";

interface RequestState {
  error?: { message: string; requestId?: string };
  pending: boolean;
}

export function PreviewTab({ canPredict }: { canPredict: boolean }): React.JSX.Element {
  const [model, setModel] = useState("");
  const [apiKeyId, setApiKeyId] = useState("");
  const [sample, setSample] = useState("");
  const [preview, setPreview] = useState<RoutingPreview>();
  const [previewState, setPreviewState] = useState<RequestState>({ pending: false });

  const [predictModel, setPredictModel] = useState("");
  const [inputTokens, setInputTokens] = useState("1000");
  const [maxTokens, setMaxTokens] = useState("600");
  const [estimate, setEstimate] = useState<RoutingCostEstimate>();
  const [predictState, setPredictState] = useState<RequestState>({ pending: false });

  const costGuard = useQuery({
    queryKey: routingCostGuardQueryKey,
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.routing.costGuard, { signal, routeId: "routing.rules" }),
  });

  const runPreview = async (): Promise<void> => {
    if (model.trim() === "") return;
    setPreviewState({ pending: true });
    try {
      const body: Record<string, unknown> = {
        model: model.trim(),
        messages: [{ role: "user", content: sample }],
      };
      if (apiKeyId.trim() !== "") body.api_key_id = apiKeyId.trim();
      const result = await apiClient.request(endpoints.domains.routing.preview, { body });
      setPreview(result);
      setPreviewState({ pending: false });
    } catch (cause) {
      setPreview(undefined);
      setPreviewState({
        pending: false,
        error: {
          message: safeAppErrorMessage(cause, "라우팅 미리보기를 실행하지 못했습니다."),
          requestId: isAppError(cause) ? cause.requestId : undefined,
        },
      });
    }
  };

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

  const apiKeySuspicious = containsPotentialSecret(apiKeyId);

  return (
    <div className="routing-panel-stack">
      <SectionCard
        title="라우팅 미리보기"
        description="실제 호출 없이 이 요청이 어떤 모델·공급자로 나갈지 계산합니다."
        actions={
          <Button
            variant="primary"
            disabled={previewState.pending || model.trim() === ""}
            onClick={() => void runPreview()}
          >
            {previewState.pending ? "확인 중" : "미리보기 실행"}
          </Button>
        }
      >
        <div className="routing-form">
          <FormField label="요청 모델" required>
            {(control) => (
              <Input
                {...control}
                value={model}
                placeholder="gpt-4.1"
                onChange={(event) => setModel(event.target.value)}
              />
            )}
          </FormField>
          <FormField
            label="정책 API 키 ID"
            description="비우면 키 정책 없이 계산합니다. 키 원문이 아니라 키 ID를 입력하세요."
            error={apiKeySuspicious ? secretSearchMessage : undefined}
          >
            {(control) => (
              <Input {...control} value={apiKeyId} onChange={(event) => setApiKeyId(event.target.value)} />
            )}
          </FormField>
        </div>
        <FormField
          label="샘플 요청 내용"
          description="복잡도·위험 점수를 계산할 때만 쓰이며 저장되지 않습니다."
        >
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              value={sample}
              onChange={(event) => setSample(event.target.value)}
            />
          )}
        </FormField>

        {previewState.error ? (
          <InlineNotice tone="danger" title="미리보기를 실행하지 못했습니다.">
            {previewState.error.message}
            {previewState.error.requestId ? ` 요청 ID: ${previewState.error.requestId}` : ""}
          </InlineNotice>
        ) : null}

        {preview ? (
          <>
            <KeyValueList
              items={[
                { label: "요청 모델", value: preview.requested_model, mono: true },
                { label: "선택 모델", value: preview.selected_model, mono: true },
                { label: "선택 공급자", value: preview.selected_provider },
                { label: "정책 API 키", value: preview.policy_api_key_id, mono: true },
                {
                  label: "복잡도",
                  value: `${formatNumber(preview.complexity?.score)} (${preview.complexity?.tier ?? "—"})`,
                },
                {
                  label: "위험",
                  value: `${formatNumber(preview.risk?.score)} (${preview.risk?.tier ?? "—"})`,
                },
                { label: "상태 점수", value: formatNumber(preview.health_score) },
                { label: "라우팅 사유", value: preview.route_reason },
                { label: "결정 사유", value: preview.decision_reason },
                {
                  label: "폴백 계획",
                  value: preview.fallback_plan.length > 0 ? preview.fallback_plan.join(" → ") : "—",
                },
              ]}
            />
            {preview.would_rewrite ? (
              <InlineNotice tone="warning" title="모델이 다시 쓰입니다.">
                이 요청은 {preview.requested_model} 대신 {preview.selected_model} 으로 나갑니다.
              </InlineNotice>
            ) : null}
          </>
        ) : (
          <EmptyState
            title="아직 미리보기를 실행하지 않았습니다."
            description="모델 이름을 넣고 실행하면 라우팅 결과와 폴백 계획을 보여 줍니다."
          />
        )}
      </SectionCard>

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
        {costGuard.isError ? (
          <QueryFailureNotice
            error={costGuard.error}
            hasData={Boolean(costGuard.data)}
            label="비용 가드 설정"
            onRetry={() => void costGuard.refetch()}
          />
        ) : null}
        <KeyValueList
          items={[
            {
              label: "비용 가드",
              value: costGuard.data ? (
                costGuard.data.enabled ? (
                  <Badge tone="success">사용 중</Badge>
                ) : (
                  <Badge tone="muted">미사용</Badge>
                )
              ) : (
                "—"
              ),
            },
            { label: "요청당 임계값", value: costGuard.data ? formatKRW(costGuard.data.threshold_krw) : "—" },
          ]}
        />
        <p className="routing-meta">비용 가드 설정 변경은 안전(Kill Switch·정책) 화면에서 합니다.</p>
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
