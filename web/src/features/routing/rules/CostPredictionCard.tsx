import { useRef, useState, type ReactNode } from "react";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatNumber } from "@/shared/utils/format";
import { useCostPredictionAccess, type CostPredictionAccess } from "./cost-prediction-access";
import { useCostPredictionOperation } from "./cost-prediction-operation";
import {
  costBasis,
  costDraftChanged,
  costFieldOrder,
  costText,
  emptyCostDraft,
  estimatedCost,
  estimatedLatency,
  type CostDraft,
  type CostErrors,
  type CostField,
} from "./cost-prediction-state";
import "./cost-prediction.css";

export function CostPredictionCard({ canPredict, children }: { canPredict: boolean; children: ReactNode }) {
  const access = useCostPredictionAccess(canPredict);
  return (
    <PredictionCard key={access.securityKey} access={access}>
      {children}
    </PredictionCard>
  );
}
function PredictionCard({ access, children }: { access: CostPredictionAccess; children: ReactNode }) {
  const [draft, setDraft] = useState<CostDraft>(emptyCostDraft);
  const latestDraft = useRef(draft);
  const [errors, setErrors] = useState<CostErrors>({});
  const modelInput = useRef<HTMLInputElement>(null);
  const inputTokens = useRef<HTMLInputElement>(null);
  const maxTokens = useRef<HTMLInputElement>(null);
  const { state, run } = useCostPredictionOperation(access);
  const pending = state.kind === "pending";
  const snapshot = state.kind === "idle" ? undefined : state.snapshot;
  const result = state.kind === "success" && access.allowed ? state.result : undefined;
  const display = (value: string | undefined) => costText(value, access.credentialPrefixes);
  function change(field: CostField, value: string) {
    const next = { ...latestDraft.current, [field]: value };
    latestDraft.current = next;
    setDraft(next);
    setErrors((previous) => ({ ...previous, [field]: undefined }));
  }
  function validation(next: CostErrors) {
    setErrors(next);
    const first = costFieldOrder.find((field) => next[field]);
    if (first === "model") modelInput.current?.focus();
    if (first === "inputTokens") inputTokens.current?.focus();
    if (first === "maxTokens") maxTokens.current?.focus();
  }
  return (
    <SectionCard
      title="비용 예측 가드"
      className="cost-prediction-card"
      description="모델을 호출하지 않고 현재 이력과 가격 정보로 예상 비용을 계산합니다. 아래 보호 설정은 별도 조회입니다."
      actions={
        <Button
          variant="primary"
          disabled={!access.allowed || pending || !draft.model.trim()}
          title={access.reason}
          onClick={() => void run(() => latestDraft.current, validation)}
        >
          {pending ? "계산 중" : "비용 예측"}
        </Button>
      }
    >
      {children}
      {access.reason ? (
        <InlineNotice tone="info" title="비용 예측 잠김">
          {access.reason}
        </InlineNotice>
      ) : null}
      <div className="routing-form">
        <FormField label="모델" required error={errors.model}>
          {(control) => (
            <Input
              {...control}
              ref={modelInput}
              value={draft.model}
              placeholder="gpt-4.1"
              onChange={(event) => change("model", event.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="입력 토큰"
          error={errors.inputTokens}
          description="0 이상의 정수를 입력하세요. 비우면 입력 토큰 0으로 계산하며 메시지에서 추정하지 않습니다."
        >
          {(control) => (
            <Input
              {...control}
              ref={inputTokens}
              type="number"
              min={0}
              step={1}
              value={draft.inputTokens}
              onChange={(event) => change("inputTokens", event.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="최대 출력 토큰"
          error={errors.maxTokens}
          description="0 이상의 정수를 입력하세요. 비우거나 0이면 사용 이력을 우선하고, 충분한 이력이 없으면 600으로 계산합니다."
        >
          {(control) => (
            <Input
              {...control}
              ref={maxTokens}
              type="number"
              min={0}
              step={1}
              value={draft.maxTokens}
              onChange={(event) => change("maxTokens", event.target.value)}
            />
          )}
        </FormField>
      </div>
      {snapshot ? (
        <>
          <KeyValueList
            items={[
              { label: "계산한 모델", value: display(snapshot.body.model), mono: true },
              { label: "계산한 입력 토큰", value: formatNumber(snapshot.body.input_tokens) },
              { label: "계산한 최대 출력 토큰", value: formatNumber(snapshot.body.max_tokens) },
            ]}
          />
          {costDraftChanged(draft, snapshot) ? (
            <InlineNotice tone="warning" title="입력이 달라졌습니다. 다시 비용을 예측하세요.">
              현재 입력은 자동으로 전송하지 않습니다. 아래 상태와 결과는 마지막 실행 기준입니다.
            </InlineNotice>
          ) : null}
        </>
      ) : null}
      {pending ? (
        <InlineNotice tone="info" title="비용을 계산하고 있습니다.">
          현재 입력을 바꾸어도 이미 보낸 계산 기준은 바뀌지 않습니다.
        </InlineNotice>
      ) : null}
      {state.kind === "withheld" ? (
        <InlineNotice tone="info" title="이전 계산 결과를 표시하지 않습니다.">
          계산이 완료될 때 권한을 확인하지 못했습니다. 권한을 확인한 뒤 비용 예측을 직접 다시 실행하세요.
        </InlineNotice>
      ) : null}
      {state.kind === "error" && access.allowed ? (
        <InlineNotice tone="danger" title="비용을 예측하지 못했습니다.">
          {state.message}
          {state.requestId ? ` 요청 ID: ${display(state.requestId)}` : ""} 입력을 확인한 뒤 직접 다시
          실행하세요.
        </InlineNotice>
      ) : null}
      {result ? (
        <>
          <InlineNotice tone="info" title="실제 청구 금액이나 호출 허가가 아닌 예상값입니다.">
            비용 보호 설정의 승인·차단을 검사한 결과는 아닙니다. 실제 사용량과 가격·서버 상태에 따라 달라질 수
            있습니다.
          </InlineNotice>
          <KeyValueList
            items={[
              { label: "모델", value: display(result.model), mono: true },
              { label: "예상 입력 토큰", value: formatNumber(result.input_tokens) },
              { label: "예상 출력 토큰", value: formatNumber(result.output_tokens) },
              { label: "예상 비용", value: estimatedCost(result) },
              { label: "예상 지연", value: estimatedLatency(result) },
              { label: "가격표 적용", value: result.priced ? "추정 가능" : "가격 정보 미확인" },
              { label: "산정 기준", value: costBasis(result.basis, access.credentialPrefixes) },
            ]}
          />
          {result.basis === "history" ? (
            <InlineNotice tone="info" title="과거 출력 평균을 사용합니다.">
              이력 기반 예상 출력은 입력한 최대 출력 토큰으로 제한되지 않습니다. 지연도 과거 평균에 따른
              추정입니다.
            </InlineNotice>
          ) : (
            <InlineNotice tone="info" title="실측 지연을 확인할 수 없습니다.">
              이 계산의 지연 값 0을 실제 모델의 응답 시간 0으로 해석하지 마세요.
            </InlineNotice>
          )}
          <InlineNotice
            tone={result.priced ? "info" : "warning"}
            title={
              result.priced ? "가격의 적용 경로는 확인할 수 없습니다." : "가격 정보를 확인하지 못했습니다."
            }
          >
            {result.priced
              ? "정확한 모델명·접두사·기본 대체 가격을 이용할 수 있으며, 이 응답은 어느 가격을 사용했는지 구분하지 않습니다."
              : "서버의 비용 값 0은 무료라는 뜻이 아닙니다. 가격 정보를 확인한 뒤 다시 계산하세요."}
          </InlineNotice>
        </>
      ) : state.kind === "idle" ? (
        <EmptyState
          title="아직 비용을 예측하지 않았습니다."
          description="모델과 토큰 수를 입력한 뒤 직접 비용 예측을 실행하세요."
        />
      ) : null}
    </SectionCard>
  );
}
