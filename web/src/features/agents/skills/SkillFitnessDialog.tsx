import { useLayoutEffect } from "react";

import {
  emptyFitnessForm,
  fitnessFormSchema,
  fitnessKindLabels,
  fitnessKinds,
  type FitnessFormValues,
} from "./skill-fitness-state";
import { SkillFitnessNotice } from "./SkillFitnessNotice";
import type { SkillFitnessDraft, SkillFitnessEditor, useSkillFitnessQuery } from "./use-skill-fitness-editor";
import { AppError } from "@/shared/api/error";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";

export function SkillFitnessDialog({
  target,
  editor,
  current,
  canWrite,
}: {
  target: SkillFitnessDraft;
  editor: SkillFitnessEditor;
  current: ReturnType<typeof useSkillFitnessQuery>;
  canWrite: boolean;
}): React.JSX.Element {
  const form = useZodForm<FitnessFormValues, FitnessFormValues>(fitnessFormSchema, { ...emptyFitnessForm });
  const { setDirty } = editor;
  const dirty = form.formState.isDirty;
  useLayoutEffect(() => setDirty(dirty), [dirty, setDirty]);
  const returnFocusRef = {
    get current(): HTMLElement | null {
      const trigger = editor.returnFocusRef.current;
      return trigger?.isConnected && trigger.matches(":disabled")
        ? (trigger.closest<HTMLElement>(".sheet-content") ?? trigger)
        : trigger;
    },
  };
  return (
    <FormDialog
      open
      form={form}
      title="스킬 적합성 근거 기록"
      description="선택한 스킬에 새 평가 근거를 추가합니다. 기존 근거를 수정하거나 덮어쓰지 않습니다."
      submitLabel="근거 기록 저장"
      submitDisabled={!canWrite || !current.confirmed}
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) editor.close(target.instance);
      }}
      onSubmit={(values) => {
        if (!canWrite) throw new AppError("스킬 쓰기 권한이 없습니다.", { kind: "permission" });
        return editor.submit(target, values);
      }}
    >
      <p className="skill-fitness-value">대상 스킬: {target.skill.name}</p>
      <p>
        열 때 확인한 통과 근거 {target.baseline.passing_count}건 · 승격 기준 {target.baseline.required}건
      </p>
      <p>이 건수만으로 승격 가능 여부가 확정되지는 않습니다.</p>
      <SkillFitnessNotice name={target.skill.name} current={current} />
      {!canWrite ? (
        <InlineNotice tone="warning">스킬 근거 기록에는 admin:write 권한이 필요합니다.</InlineNotice>
      ) : null}
      <Button
        size="small"
        disabled={editor.pending || current.query.isFetching}
        onClick={() => void current.query.refetch()}
      >
        현재 근거 다시 조회
      </Button>
      <InlineNotice tone="warning" title="같은 참조를 다시 기록해도 별도 근거로 추가됩니다.">
        서버는 참조 ID의 존재나 평가 결과를 확인하지 않습니다. 통과한 기록은 중복 참조도 승격 요건 건수에
        반영됩니다. 결과가 불분명하면 다시 저장하기 전에 목록을 조회하세요.
      </InlineNotice>
      <p>
        조회가 갱신되어도 대상과 초안은 바뀌지 않습니다. 이미 보낸 기록을 취소하거나 다른 관리자의 기록을 막는
        기능은 아닙니다.
      </p>
      <FormField label="근거 종류" required error={form.formState.errors.kind?.message}>
        {(control) => (
          <Select
            {...control}
            {...form.register("kind")}
            disabled={!canWrite}
            options={fitnessKinds.map((kind) => ({ value: kind, label: fitnessKindLabels[kind] }))}
          />
        )}
      </FormField>
      <FormField
        label="참조 ID"
        required
        description="평가 실행·기준 답안 세트·테스트 사례를 다시 찾을 식별자입니다."
        error={form.formState.errors.ref_id?.message}
      >
        {(control) => <Input {...control} {...form.register("ref_id")} disabled={!canWrite} />}
      </FormField>
      <FormField
        label="점수"
        description="비워 두면 기존 계약대로 0으로 기록합니다. 점수는 통과 여부를 자동 판정하지 않습니다."
        error={form.formState.errors.score?.message}
      >
        {(control) => (
          <Input {...control} inputMode="decimal" {...form.register("score")} disabled={!canWrite} />
        )}
      </FormField>
      <FormField
        label="메모"
        description="참조 ID와 메모는 관리자 읽기 권한으로 조회할 수 있습니다. 비밀값이나 프롬프트·응답 원문을 입력하지 마세요."
        error={form.formState.errors.note?.message}
      >
        {(control) => <Textarea {...control} rows={3} {...form.register("note")} disabled={!canWrite} />}
      </FormField>
      <Checkbox
        label="통과"
        description="점수와 별개로 직접 선택합니다. 통과한 기록만 승격 요건 건수에 반영됩니다."
        {...form.register("passed")}
        disabled={!canWrite}
      />
    </FormDialog>
  );
}
