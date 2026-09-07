import { useEffect, type RefObject } from "react";
import { z } from "zod";

import { skillRiskOptions } from "@/features/agents/skills/skill-form";
import type { SkillAdoptBody, SkillCandidate } from "@/shared/api/domains/agents.schemas";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";

const adoptSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Skill 이름을 입력하세요.")
      .regex(/^[a-z0-9][a-z0-9-]*$/u, "소문자, 숫자, 하이픈만 사용할 수 있습니다."),
    description: z.string(),
    risk_level: z.string(),
    allowed_models: z.string(),
    allowed_tools: z.string(),
    instructions: z.string().trim().min(1, "지침을 입력하세요."),
  })
  .transform((values) => ({
    name: values.name.trim(),
    description: values.description.trim(),
    risk_level: values.risk_level,
    allowed_models: values.allowed_models.trim(),
    allowed_tools: values.allowed_tools.trim(),
    instructions: values.instructions,
  }));

type AdoptInput = z.input<typeof adoptSchema>;
type AdoptOutput = z.output<typeof adoptSchema>;

function defaults(candidate?: SkillCandidate): AdoptInput {
  return {
    name: candidate?.suggested_name ?? candidate?.id ?? "",
    description: candidate?.description ?? candidate?.title ?? "",
    risk_level: candidate?.suggested?.risk_level ?? "low",
    allowed_models: candidate?.suggested?.allowed_models ?? "",
    allowed_tools: candidate?.suggested?.allowed_tools ?? "",
    instructions: candidate?.suggested?.instructions ?? "",
  };
}

interface SkillAdoptDialogProps {
  candidate: SkillCandidate | undefined;
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: SkillAdoptBody) => Promise<unknown>;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
}

/** Adopts a mined candidate as a draft skill; the lifecycle gate handles the rest. */
export function SkillAdoptDialog({
  candidate,
  onOpenChange,
  onSubmit,
  open,
  returnFocusRef,
}: SkillAdoptDialogProps): React.JSX.Element {
  const form = useZodForm<AdoptInput, AdoptOutput>(adoptSchema, defaults(candidate));
  const { reset } = form;
  useEffect(() => {
    if (open) reset(defaults(candidate));
  }, [candidate, open, reset]);
  const errors = form.formState.errors;

  return (
    <FormDialog
      description="후보를 초안(draft) Skill로 채택합니다. 승격은 게이트를 통과한 뒤에만 가능합니다."
      form={form}
      onOpenChange={onOpenChange}
      onSubmit={(values) => onSubmit({ ...values, source: candidate?.source ?? "" })}
      open={open}
      returnFocusRef={returnFocusRef}
      submitLabel="초안으로 채택"
      title="후보를 Skill로 채택"
    >
      <FormField label="이름" required error={errors.name?.message}>
        {(control) => <Input {...control} {...form.register("name")} />}
      </FormField>
      <FormField label="설명" error={errors.description?.message}>
        {(control) => <Textarea {...control} rows={2} {...form.register("description")} />}
      </FormField>
      <FormField label="위험 등급" error={errors.risk_level?.message}>
        {(control) => <Select {...control} options={skillRiskOptions} {...form.register("risk_level")} />}
      </FormField>
      <FormField label="허용 모델" error={errors.allowed_models?.message}>
        {(control) => <Input {...control} {...form.register("allowed_models")} />}
      </FormField>
      <FormField label="허용 도구" error={errors.allowed_tools?.message}>
        {(control) => <Input {...control} {...form.register("allowed_tools")} />}
      </FormField>
      <FormField label="지침(instructions)" required error={errors.instructions?.message}>
        {(control) => <Textarea {...control} rows={10} {...form.register("instructions")} />}
      </FormField>
    </FormDialog>
  );
}
