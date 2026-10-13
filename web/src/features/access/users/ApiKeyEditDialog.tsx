import { useState, type RefObject } from "react";
import { editKeySchema } from "./api-key-form";
import { ApiKeyEditFields } from "./ApiKeyEditFields";
import { KeyEditReview } from "./KeyEditReview";
import { keyEditError } from "./key-edit-error";
import { keyEditReasonSchema, useKeyEditReview } from "./use-key-edit-review";
import { z } from "zod";
import { statusLabel } from "@/features/access/access-format";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import type { UpdateApiKeyBody } from "@/shared/api/domains/access";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Input } from "@/shared/components/ui/Input";

const schema = editKeySchema.extend({
  reason: keyEditReasonSchema,
  status: editKeySchema.shape.status.or(z.literal("unchanged")),
});
export type ReviewedKeyEditForm = z.infer<typeof schema>;
const fields = ["name", "owner", "team", "role", "status"] as const;
const labels = { name: "이름", owner: "소유자", team: "팀", role: "역할", status: "상태" };
const display = (field: (typeof fields)[number], value: string) =>
  field === "status" ? statusLabel(value) : value;
function changedBody(baseline: ApiKeyPublic, values: ReviewedKeyEditForm): UpdateApiKeyBody {
  const body: UpdateApiKeyBody = {};
  for (const field of fields) {
    if (field === "status" && values.status === "unchanged") continue;
    if (values[field].trim() !== baseline[field]) {
      if (field === "status") {
        if (values.status !== "unchanged") body.status = values.status;
      } else body[field] = values[field].trim();
    }
  }
  return body;
}

export function ApiKeyEditDialog({
  target,
  owner,
  canWrite,
  onOpenChange,
  onSubmit,
  returnFocusRef,
}: {
  target: ApiKeyPublic;
  owner: string;
  canWrite: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (id: string, body: UpdateApiKeyBody) => Promise<unknown>;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [baseline] = useState(() => ({ ...target }));
  const review = useKeyEditReview(baseline, owner);
  const form = useZodForm<ReviewedKeyEditForm, ReviewedKeyEditForm>(schema, {
    name: baseline.name,
    owner: baseline.owner,
    team: baseline.team,
    role: baseline.role,
    status: baseline.status === "disabled" || baseline.status === "active" ? baseline.status : "unchanged",
    reason: "",
  });
  const values = form.watch();
  const body = changedBody(baseline, values);
  const signature = JSON.stringify(values);
  const changes = fields
    .filter((field) => body[field] !== undefined)
    .map((field) => ({
      label: labels[field],
      before: display(field, baseline[field]),
      after: display(field, values[field].trim()),
    }));
  return (
    <FormDialog
      errorFormatter={keyEditError}
      open
      form={form}
      title="API 키 수정"
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      description="소유자는 표시용 정보이며 사용자 계정을 바꾸지 않습니다. 팀·역할·상태 변경은 이후 인증과 권한에 영향을 줄 수 있습니다."
      submitLabel="검토한 변경 저장"
      submitDisabled={!canWrite || !review.ready || review.attempted || changes.length === 0}
      onSubmit={(submitted) =>
        onSubmit(baseline.id, {
          ...changedBody(baseline, submitted),
          review: review.begin(
            submitted.reason,
            canWrite && JSON.stringify(form.getValues()) === signature && changes.length > 0,
          ),
        })
      }
    >
      <ApiKeyEditFields form={form} currentStatus={baseline.status} />
      <FormField
        label="변경 사유"
        required
        error={form.formState.errors.reason?.message}
        description="감사 이력에 기록됩니다. 비밀값이나 개인정보는 입력하지 마세요."
      >
        {(control) => <Input {...control} {...form.register("reason")} />}
      </FormField>
      <KeyEditReview
        changes={changes}
        signature={signature}
        confirmation={review.confirmation}
        ready={review.ready}
        attempted={review.attempted}
        canWrite={canWrite}
      />
    </FormDialog>
  );
}
