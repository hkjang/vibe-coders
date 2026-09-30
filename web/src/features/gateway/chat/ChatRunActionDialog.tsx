import type { RefObject } from "react";
import { safeModelLabel } from "./chat-console";
import {
  ratings,
  runActionDefaults,
  runActionLabels,
  runActionSchema,
  type RunActionSnapshot,
  type RunActionValues,
} from "./run-action-state";
import type { CompareAccess } from "./use-compare-access";
import { useRunActionSubmit } from "./use-run-action-submit";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import "./chat-run-action-dialog.css";

export function ChatRunActionDialog({
  snapshot,
  access,
  close,
  returnFocusRef,
}: {
  snapshot: RunActionSnapshot;
  access: CompareAccess;
  close: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const form = useZodForm<RunActionValues, RunActionValues>(
    runActionSchema(snapshot.kind),
    runActionDefaults(snapshot),
  );
  const submit = useRunActionSubmit(snapshot, access);
  const labels = runActionLabels[snapshot.kind];
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      returnFocusRef={returnFocusRef}
      title={labels.title}
      description={`실행 ID: ${snapshot.runId}. ${labels.description}`}
      form={form}
      onSubmit={submit}
      submitLabel={labels.submit}
      submitDisabled={!access.write.allowed}
    >
      {!access.write.allowed ? (
        <InlineNotice tone="warning" title="지금은 저장할 수 없습니다.">
          {access.write.reason}
        </InlineNotice>
      ) : null}
      <fieldset
        className="form-grid form-dialog-fields chat-run-action-draft"
        disabled={!access.write.allowed}
        aria-label="실행 작업 입력"
      >
        <FormField label="모델" required error={form.formState.errors.model?.message}>
          {(control) => (
            <Select
              {...control}
              {...form.register("model")}
              options={snapshot.models.map((model) => ({ value: model, label: safeModelLabel(model) }))}
            />
          )}
        </FormField>
        {snapshot.kind === "feedback" ? (
          <>
            <FormField label="평점" required description="0(최하)에서 5(최고)까지 매깁니다.">
              {(control) => (
                <Select
                  {...control}
                  {...form.register("rating")}
                  options={ratings.map((value) => ({ value, label: `${value}점` }))}
                />
              )}
            </FormField>
            <FormField label="라벨" description="예: best, wrong_format">
              {(control) => <Input {...control} {...form.register("label")} />}
            </FormField>
            <FormField label="의견">
              {(control) => <Textarea {...control} rows={3} {...form.register("comment")} />}
            </FormField>
          </>
        ) : null}
        {snapshot.kind === "promote" ? (
          <>
            <FormField label="작업 유형" description="예: sql, code_review, summary">
              {(control) => <Input {...control} {...form.register("task_type")} />}
            </FormField>
            <FormField label="사유" required error={form.formState.errors.reason?.message}>
              {(control) => <Textarea {...control} rows={3} {...form.register("reason")} />}
            </FormField>
          </>
        ) : null}
        {snapshot.kind === "golden" ? (
          <>
            <FormField
              label="워크플로 이름"
              description="새 워크플로를 만들 때 입력합니다."
              error={form.formState.errors.workflow_name?.message}
            >
              {(control) => <Input {...control} {...form.register("workflow_name")} />}
            </FormField>
            <FormField label="기존 워크플로 ID" description="기존 워크플로에 단계를 덧붙일 때 입력합니다.">
              {(control) => <Input {...control} {...form.register("workflow_id")} />}
            </FormField>
            <FormField label="단계 이름" description="비우면 모델 이름으로 만듭니다.">
              {(control) => <Input {...control} {...form.register("step_name")} />}
            </FormField>
            <FormField label="작업 유형">
              {(control) => <Input {...control} {...form.register("task_type")} />}
            </FormField>
            <FormField label="기대 문구" description="회귀 검사에서 답변에 있어야 하는 표시입니다.">
              {(control) => <Textarea {...control} rows={2} {...form.register("expected")} />}
            </FormField>
          </>
        ) : null}
      </fieldset>
    </FormDialog>
  );
}
