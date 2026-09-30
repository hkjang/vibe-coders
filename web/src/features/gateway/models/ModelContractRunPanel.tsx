import { useRef, useState } from "react";
import { useModelGovernanceMutations } from "./use-model-governance";
import { ModelQueryFailure } from "./ModelGovernanceState";
import { trimModelSpace } from "./model-governance-form";
import type { ModelContractRun } from "@/shared/api/domains/gateway.schemas";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";

const verdicts = new Map([
  ["pass", "충족"],
  ["warn", "주의"],
  ["fail", "미달"],
  ["no_data", "데이터 부족"],
  ["skip", "검사하지 않음"],
]);
const dimensions = new Map([
  ["quality_score", ["품질 점수", "점"]],
  ["golden_pass_rate", ["골든 통과율", "비율"]],
  ["success_rate", ["성공률", "비율"]],
  ["avg_latency_ms", ["평균 지연", "ms"]],
  ["avg_cost_krw", ["평균 비용", "원"]],
]);
export function ModelContractRunPanel() {
  const { access, runContract } = useModelGovernanceMutations();
  const [model, setModel] = useState("");
  const [result, setResult] = useState<ModelContractRun>();
  const [error, setError] = useState<unknown>();
  const flight = useRef(false);
  const run = async () => {
    if (!trimModelSpace(model) || flight.current) return;
    try {
      access.run.assertCurrent();
      flight.current = true;
      setError(undefined);
      const next = await runContract.mutateAsync({ model: trimModelSpace(model) });
      access.run.assertCurrent();
      setResult(next);
    } catch (cause) {
      // Both successful and failed old work must leave a newer screen alone.
      try {
        access.run.assertCurrent();
      } catch {
        return;
      }
      setResult(undefined);
      setError(cause);
    } finally {
      flight.current = false;
    }
  };
  return (
    <SectionCard
      title="계약 검증 실행"
      description="저장된 관측 지표와 계약 기준을 비교합니다. 모델을 호출하거나 설정을 저장하지 않습니다. 읽기 전용 화면에서도 기존 admin:write 권한이 있으면 실행할 수 있습니다."
    >
      <div className="toolbar">
        <div className="toolbar-start">
          <FormField label="검증할 모델">
            {(control) => (
              <Input
                {...control}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={runContract.isPending}
              />
            )}
          </FormField>
          <Button
            variant="secondary"
            disabled={!access.run.allowed || !trimModelSpace(model) || runContract.isPending}
            title={access.run.reason}
            onClick={() => void run()}
          >
            계약 검증 실행
          </Button>
        </div>
      </div>
      {access.run.reason ? <InlineNotice tone="warning">{access.run.reason}</InlineNotice> : null}
      {error ? (
        <ModelQueryFailure
          title="계약 검증을 완료하지 못했습니다."
          error={error}
          retry={() => void run()}
          disabled={!access.run.allowed || runContract.isPending}
        />
      ) : null}
      {result ? (
        <div className="page-stack">
          <InlineNotice tone={result.replaceable ? "success" : "warning"} title="검증 결과">
            {result.replaceable
              ? "관측 지표가 활성 계약 기준을 충족하거나 주의 범위에 있습니다."
              : "계약 또는 관측 지표를 확인하세요. 현재 결과만으로 모델 교체의 안전을 보장할 수 없습니다."}
          </InlineNotice>
          <p>
            실제 호출 성공이나 승격·교체를 보장하는 결과가 아닙니다. 데이터가 부족한 항목은 별도로 확인하세요.
          </p>
          <ul className="gateway-list">
            {result.results.map((item, index) => (
              <li key={`${item.contract_id}-${index}`}>
                <strong>
                  {item.contract_name || item.contract_id} ·{" "}
                  {verdicts.get(item.verdict ?? "") ?? item.verdict}
                </strong>
                <span>
                  {item.checks
                    .map((check) => {
                      const [label, unit] = dimensions.get(check.dimension) ?? ["기타 기준", ""];
                      return `${label}: ${verdicts.get(check.status) ?? "판정 미확인"} · 기준 ${check.threshold}${unit} / 관측 ${check.actual === null ? "데이터 없음" : `${check.actual}${unit}`}`;
                    })
                    .join(" · ") || "검사 항목 없음"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionCard>
  );
}
