import { useEffect, type RefObject } from "react";

import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import type { Workflow } from "@/shared/api/domains/agents.schemas";
import {
  workflowFormDefaults,
  workflowFormSchema,
  workflowStepsExample,
  type WorkflowFormInput,
  type WorkflowFormOutput,
} from "@/features/agents/workflows/workflow-form";

interface WorkflowFormDialogProps {
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: WorkflowFormOutput) => Promise<unknown>;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  workflow?: Workflow;
}

export function WorkflowFormDialog({
  onOpenChange,
  onSubmit,
  open,
  returnFocusRef,
  workflow,
}: WorkflowFormDialogProps): React.JSX.Element {
  const form = useZodForm<WorkflowFormInput, WorkflowFormOutput>(
    workflowFormSchema,
    workflowFormDefaults(workflow),
  );
  const { reset } = form;
  useEffect(() => {
    if (open) reset(workflowFormDefaults(workflow));
  }, [open, reset, workflow]);
  const errors = form.formState.errors;

  return (
    <FormDialog
      description="워크플로 이름과 단계 정의(JSON)를 입력합니다. 저장해도 게시되지 않으며, 드라이런으로 검증한 뒤 게시하세요."
      form={form}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      open={open}
      returnFocusRef={returnFocusRef}
      submitLabel={workflow ? "수정 저장" : "워크플로 만들기"}
      title={workflow ? "워크플로 수정" : "새 워크플로"}
    >
      <FormField label="이름" required error={errors.name?.message}>
        {(control) => <Input {...control} {...form.register("name")} />}
      </FormField>
      <FormField label="설명" error={errors.description?.message}>
        {(control) => <Textarea {...control} rows={2} {...form.register("description")} />}
      </FormField>
      <FormField
        label="허용 팀"
        description="쉼표로 구분합니다. 비워 두면 모든 팀이 실행할 수 있습니다."
        error={errors.allowed_teams?.message}
      >
        {(control) => <Input {...control} {...form.register("allowed_teams")} />}
      </FormField>
      <FormField
        label="단계 정의 (JSON 배열)"
        description="각 단계는 name과 type을 가집니다. type: chat, text2sql, mcp_tool, skill, condition, approval, transform"
        required
        error={errors.steps?.message}
      >
        {(control) => <Textarea {...control} rows={12} className="mono" {...form.register("steps")} />}
      </FormField>
      <Button
        size="small"
        variant="ghost"
        onClick={() => form.setValue("steps", workflowStepsExample, { shouldValidate: true })}
      >
        안전한 예시 채우기
      </Button>
      <FormField label="사용 여부" error={errors.enabled?.message}>
        {(control) => (
          <Checkbox {...control} label="이 워크플로를 사용합니다." {...form.register("enabled")} />
        )}
      </FormField>
    </FormDialog>
  );
}
