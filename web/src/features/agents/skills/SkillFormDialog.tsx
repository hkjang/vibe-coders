import { useEffect, type RefObject } from "react";

import {
  skillFormDefaults,
  skillFormSchema,
  skillRiskOptions,
  skillStatusOptions,
  type SkillFormInput,
  type SkillFormOutput,
} from "@/features/agents/skills/skill-form";
import type { Skill } from "@/shared/api/domains/agents.schemas";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";

interface SkillFormDialogProps {
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: SkillFormOutput) => Promise<unknown>;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  skill?: Skill;
}

export function SkillFormDialog({
  onOpenChange,
  onSubmit,
  open,
  returnFocusRef,
  skill,
}: SkillFormDialogProps): React.JSX.Element {
  const form = useZodForm<SkillFormInput, SkillFormOutput>(skillFormSchema, skillFormDefaults(skill));
  const { reset } = form;
  useEffect(() => {
    if (open) reset(skillFormDefaults(skill));
  }, [open, reset, skill]);
  const errors = form.formState.errors;

  return (
    <FormDialog
      description="Skill 정의와 실행 정책을 편집합니다. 프로덕션 승격에는 모델·도구·팀 허용 목록과 일일 한도가 모두 필요합니다."
      form={form}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      open={open}
      returnFocusRef={returnFocusRef}
      submitLabel={skill ? "수정 저장" : "Skill 만들기"}
      title={skill ? `Skill 수정 · ${skill.name}` : "새 Skill"}
    >
      <FormField label="이름" required error={errors.name?.message}>
        {(control) => <Input {...control} readOnly={skill !== undefined} {...form.register("name")} />}
      </FormField>
      <FormField label="설명" error={errors.description?.message}>
        {(control) => <Textarea {...control} rows={2} {...form.register("description")} />}
      </FormField>
      <FormField label="버전" description="비우면 0.1.0으로 시작합니다." error={errors.version?.message}>
        {(control) => <Input {...control} {...form.register("version")} />}
      </FormField>
      <FormField label="책임자" error={errors.owner?.message}>
        {(control) => <Input {...control} {...form.register("owner")} />}
      </FormField>
      <FormField label="상태" error={errors.status?.message}>
        {(control) => <Select {...control} options={skillStatusOptions} {...form.register("status")} />}
      </FormField>
      <FormField label="위험 등급" error={errors.risk_level?.message}>
        {(control) => <Select {...control} options={skillRiskOptions} {...form.register("risk_level")} />}
      </FormField>
      <FormField
        label="허용 모델"
        description="쉼표로 구분한 글롭 패턴. 비우면 제한 없음."
        error={errors.allowed_models?.message}
      >
        {(control) => <Input {...control} {...form.register("allowed_models")} />}
      </FormField>
      <FormField
        label="허용 도구"
        description="쉼표로 구분한 도구/서버 이름. 비우면 제한 없음."
        error={errors.allowed_tools?.message}
      >
        {(control) => <Input {...control} {...form.register("allowed_tools")} />}
      </FormField>
      <FormField
        label="허용 팀"
        description="쉼표로 구분. 비우면 모든 팀이 사용합니다."
        error={errors.allowed_teams?.message}
      >
        {(control) => <Input {...control} {...form.register("allowed_teams")} />}
      </FormField>
      <FormField
        label="일일 한도"
        description="UTC 하루 최대 실행 횟수. 0이면 무제한입니다."
        error={errors.daily_limit?.message}
      >
        {(control) => <Input {...control} inputMode="numeric" {...form.register("daily_limit")} />}
      </FormField>
      <FormField
        label="지침(instructions)"
        description="호출자에게 전달되는 절차입니다. 비밀정보나 파괴적 명령을 넣지 마세요."
        error={errors.instructions?.message}
      >
        {(control) => <Textarea {...control} rows={10} {...form.register("instructions")} />}
      </FormField>
    </FormDialog>
  );
}
