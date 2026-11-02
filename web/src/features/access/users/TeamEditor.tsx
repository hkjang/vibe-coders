import { useState, type RefObject } from "react";
import { z } from "zod";
import type { AuthTeamRow } from "@/shared/api/domains/access.schemas";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Input } from "@/shared/components/ui/Input";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";

const schema = z.object({
  id: z
    .string()
    .trim()
    .min(1, "팀 ID를 입력하세요.")
    .max(256, "팀 ID는 256자 이내로 입력하세요.")
    .refine(
      (value) => ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
      "팀 ID에는 제어 문자를 사용할 수 없습니다.",
    ),
  name: z.string().trim().min(1, "팀 이름을 입력하세요."),
});
export function TeamEditor({
  baseline,
  allowed,
  reason,
  onClose,
  onSave,
  returnFocusRef,
}: {
  baseline?: AuthTeamRow;
  allowed: boolean;
  reason?: string;
  onClose: () => void;
  onSave: (values: z.output<typeof schema>) => Promise<unknown>;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [initial] = useState(() => ({
    // getRandomValues also works on intranet HTTP; randomUUID requires a secure context.
    id:
      baseline?.id ??
      `team_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    name: baseline?.name ?? "",
  }));
  const form = useZodForm(baseline ? schema.extend({ id: z.literal(baseline.id) }) : schema, initial);
  const draft = form.watch();
  return (
    <FormDialog
      form={form}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      title={baseline ? "팀 이름 수정" : "팀 추가"}
      submitDisabled={!allowed}
      onSubmit={onSave}
      description="저장 직전에 팀 목록을 다시 확인합니다. 다른 관리자의 동시 변경을 잠그지는 않습니다."
    >
      {!allowed ? (
        <InlineNotice tone="warning">{reason ?? "최신 팀 목록과 변경 권한을 확인하세요."}</InlineNotice>
      ) : null}
      <FormField label="팀 이름" required error={form.formState.errors.name?.message}>
        {(control) => <Input {...control} {...form.register("name")} />}
      </FormField>
      <FormField
        label="팀 ID"
        required
        error={form.formState.errors.id?.message}
        description={
          baseline
            ? "기존 팀의 ID는 변경하지 않습니다."
            : "새 ID를 제안했습니다. 다른 ID로 바꿀 수 있지만 기존 팀 ID는 사용할 수 없습니다."
        }
      >
        {(control) => <Input {...control} readOnly={Boolean(baseline)} {...form.register("id")} />}
      </FormField>
      <section aria-label="팀 변경 전후 비교" className="access-stack access-team-edit-review">
        <h3>저장할 변경 내용</h3>
        <p>팀 ID: {draft.id.trim() || "미입력"}</p>
        <p>변경 전 이름: {baseline?.name ?? "새 팀"}</p>
        <p>변경 후 이름: {draft.name.trim() || "미입력"}</p>
        <p>
          계정의 팀 ID와 API 키의 자유 입력 팀 값은 바꾸지 않습니다. 실제 사용량 집계에 대한 전체 영향 분석은
          아닙니다.
        </p>
      </section>
    </FormDialog>
  );
}
