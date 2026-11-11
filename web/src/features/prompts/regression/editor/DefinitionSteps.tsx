import { useLayoutEffect, useRef, useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import { emptyStep, type DefinitionInput, type DefinitionValues } from "./definition-form";

export function DefinitionSteps({
  form,
}: {
  form: UseFormReturn<DefinitionInput, unknown, DefinitionValues>;
}) {
  const rows = useWatch({ control: form.control, name: "steps" });
  const [keys, setKeys] = useState(() => form.getValues("steps").map((_, index) => index));
  const nextKey = useRef(keys.length);
  const focus = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (focus.current === undefined) return;
    form.setFocus(`steps.${focus.current}.name`);
    focus.current = undefined;
  });
  const replace = (next: DefinitionInput["steps"], nextKeys: number[], focusIndex?: number) => {
    // Rebind indexed registrations after a move/remove; retain initial defaults
    // so the shared dirty guard still compares the complete draft.
    form.unregister("steps", { keepDefaultValue: true });
    form.setValue("steps", next, { shouldDirty: true, shouldValidate: true });
    focus.current = focusIndex;
    setKeys(nextKeys);
  };
  const move = (index: number, destination: number) => {
    const next = [...form.getValues("steps")],
      nextKeys = [...keys];
    const row = next[index],
      key = nextKeys[index];
    if (!row || key === undefined || destination < 0 || destination >= next.length) return;
    next.splice(index, 1);
    next.splice(destination, 0, row);
    nextKeys.splice(index, 1);
    nextKeys.splice(destination, 0, key);
    replace(next, nextKeys, destination);
  };
  const errors = form.formState.errors;
  return (
    <section className="page-stack" aria-label="검증 단계 편집">
      <h3>검증 단계 · {rows.length}개</h3>
      <p className="muted">
        각 단계는 독립적인 프롬프트입니다. 순서를 바꿔도 출처 정보는 해당 단계에 유지됩니다.
      </p>
      {errors.steps?.message ? <p role="alert">{errors.steps.message}</p> : null}
      {rows.map((row, index) => (
        <fieldset className="regression-step" key={keys[index]}>
          <legend>{index + 1}단계</legend>
          <FormField label={`${index + 1}단계 이름`} error={errors.steps?.[index]?.name?.message}>
            {(control) => <Input {...control} {...form.register(`steps.${index}.name`)} />}
          </FormField>
          <FormField
            label={`${index + 1}단계 검사 프롬프트`}
            required
            error={errors.steps?.[index]?.prompt?.message}
          >
            {(control) => <Textarea {...control} rows={4} {...form.register(`steps.${index}.prompt`)} />}
          </FormField>
          <FormField label={`${index + 1}단계 기대 내용`} error={errors.steps?.[index]?.expected?.message}>
            {(control) => <Textarea {...control} rows={3} {...form.register(`steps.${index}.expected`)} />}
          </FormField>
          <details>
            <summary>{index + 1}단계 출처 정보</summary>
            <dl className="regression-metadata">
              <dt>업무 유형</dt>
              <dd>{row.task_type || "미등록"}</dd>
              <dt>선택 모델</dt>
              <dd>{row.selected_model || "미등록"}</dd>
              <dt>참고 점수</dt>
              <dd>{row.baseline_score ?? "미등록"}</dd>
              <dt>계약</dt>
              <dd>{row.contract_id || "미등록"}</dd>
              <dt>평가 기준</dt>
              <dd>{row.rubric_id || "미등록"}</dd>
              <dt>출처 실행</dt>
              <dd>{row.source_run_id || "미등록"}</dd>
            </dl>
          </details>
          <div className="regression-editor-actions">
            <Button
              aria-label={`${index + 1}단계 위로 이동`}
              disabled={index === 0}
              onClick={() => move(index, index - 1)}
            >
              위로
            </Button>
            <Button
              aria-label={`${index + 1}단계 아래로 이동`}
              disabled={index === rows.length - 1}
              onClick={() => move(index, index + 1)}
            >
              아래로
            </Button>
            <Button
              aria-label={`${index + 1}단계 삭제`}
              disabled={rows.length === 1}
              onClick={() =>
                replace(
                  form.getValues("steps").filter((_, position) => position !== index),
                  keys.filter((_, position) => position !== index),
                  Math.min(index, rows.length - 2),
                )
              }
            >
              단계 삭제
            </Button>
          </div>
        </fieldset>
      ))}
      <Button
        onClick={() =>
          replace([...form.getValues("steps"), emptyStep()], [...keys, nextKey.current++], rows.length)
        }
      >
        검증 단계 추가
      </Button>
    </section>
  );
}
