import { z } from "zod";
import type { RefObject } from "react";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Input } from "@/shared/components/ui/Input";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { RequestCriteriaReview } from "./RequestCriteriaReview";
import { savedFilterNameError, type SavedRequestCriteria } from "./request-saved-filter";

export interface FilterEditor {
  id?: string;
  name: string;
  criteria?: SavedRequestCriteria;
}

export function RequestFilterNameDialog({
  editor,
  prefixes,
  deniedReason,
  onClose,
  onSubmit,
  returnFocusRef,
}: {
  editor: FilterEditor;
  prefixes: readonly string[];
  deniedReason?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<unknown>;
  returnFocusRef: RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const schema = z.object({
    name: z
      .string()
      .superRefine((value, ctx) => {
        const error = savedFilterNameError(value, prefixes);
        if (error) ctx.addIssue({ code: "custom", message: error });
      })
      .transform((value) => value.trim()),
  });
  const form = useZodForm(schema, { name: editor.name }, { mode: "onTouched" });
  return (
    <FormDialog
      form={form}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={editor.id ? "공유 필터 이름 변경" : "현재 조건을 공유 필터로 저장"}
      description="목록에 적용된 조회 조건을 관리자가 함께 사용합니다. 이름에는 개인정보나 비밀 정보를 입력하지 마세요."
      returnFocusRef={returnFocusRef}
      submitDisabled={Boolean(deniedReason)}
      submitLabel={editor.id ? "이름 변경" : "공유 필터 저장"}
      onSubmit={({ name }) => onSubmit(name)}
    >
      {deniedReason ? <InlineNotice tone="warning">{deniedReason}</InlineNotice> : null}
      <FormField
        id="request-filter-name"
        label="필터 이름"
        required
        error={form.formState.errors.name?.message}
        description="예: 운영 모델의 서버 오류 · 최대 80자"
      >
        {(control) => (
          <Input
            {...control}
            {...form.register("name")}
            disabled={Boolean(deniedReason)}
            autoComplete="off"
          />
        )}
      </FormField>
      {editor.criteria ? (
        <RequestCriteriaReview criteria={editor.criteria} />
      ) : (
        <p>이름만 변경하며 저장된 조회 조건은 유지합니다.</p>
      )}
    </FormDialog>
  );
}
