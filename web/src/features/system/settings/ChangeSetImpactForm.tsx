import type { UseFormReturn } from "react-hook-form";
import type { SimulateValues } from "./change-set-model";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";

export function ChangeSetImpactForm({
  form,
  pending,
  onSubmit,
  result,
}: {
  form: UseFormReturn<SimulateValues, unknown, SimulateValues>;
  pending: boolean;
  onSubmit: (values: SimulateValues) => void;
  result: unknown;
}): React.JSX.Element {
  const changeType = form.watch("change_type");
  return (
    <SectionCard
      title="변경 영향도 시뮬레이터"
      headingLevel={3}
      description="아래에 입력한 가정을 최근 사용 기록에 대입합니다. 선택한 변경 세트와는 독립적인 추정이며, 설정을 적용하거나 해당 세트의 안전성을 보증하지 않습니다."
    >
      <form
        className="form-grid"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit((values) => {
            onSubmit(values);
          })(event);
        }}
      >
        <FormField label="변경 유형">
          {(control) => (
            <Select
              {...control}
              {...form.register("change_type")}
              options={[
                { value: "block_model", label: "모델 차단" },
                { value: "model_price", label: "모델 단가 변경" },
                { value: "route_remap", label: "모델 경로 변경" },
              ]}
            />
          )}
        </FormField>
        <FormField label="분석 기간(일)" error={form.formState.errors.days?.message}>
          {(control) => <Input {...control} type="number" min={1} max={90} {...form.register("days")} />}
        </FormField>

        {changeType === "block_model" ? (
          <FormField label="모델 패턴" description="쉼표로 구분한 glob 패턴 (예: gpt-4*,claude-*)">
            {(control) => <Input {...control} {...form.register("pattern")} />}
          </FormField>
        ) : null}

        {changeType === "model_price" ? (
          <>
            <FormField label="모델">
              {(control) => <Input {...control} {...form.register("model")} />}
            </FormField>
            <FormField label="새 입력 단가(1M 토큰, 원)">
              {(control) => <Input {...control} type="number" {...form.register("input_krw_per_1m")} />}
            </FormField>
            <FormField label="새 출력 단가(1M 토큰, 원)">
              {(control) => <Input {...control} type="number" {...form.register("output_krw_per_1m")} />}
            </FormField>
          </>
        ) : null}

        {changeType === "route_remap" ? (
          <>
            <FormField label="원본 모델">
              {(control) => <Input {...control} {...form.register("from")} />}
            </FormField>
            <FormField label="대상 모델">
              {(control) => <Input {...control} {...form.register("to")} />}
            </FormField>
          </>
        ) : null}

        <div className="settings-form-actions">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "계산 중" : "영향도 계산"}
          </Button>
        </div>
      </form>
      {result ? <JsonBlock label="영향도 결과" value={result} /> : null}
    </SectionCard>
  );
}
