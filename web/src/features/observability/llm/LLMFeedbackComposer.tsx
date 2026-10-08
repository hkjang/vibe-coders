import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";

import type { LLMFeedbackDraft as Draft } from "./llm-feedback-draft";

export function LLMFeedbackRecoveryNotice({ draft }: { draft: Draft }): React.JSX.Element | null {
  return draft.retained ? (
    <InlineNotice
      tone="info"
      title="피드백 입력을 임시 보관했습니다."
      actions={<Button onClick={draft.discard}>보관된 피드백 초안 버리기</Button>}
    >
      현재 목록에서 같은 요청의 상세를 새로 확인한 뒤 ‘피드백 초안 다시 열기’를 선택하세요. 이미 전송한 초안은
      다시 보내지 않습니다. 초안을 버려도 서버의 처리 결과는 취소되지 않습니다.
    </InlineNotice>
  ) : null;
}

export function LLMFeedbackComposer({
  draft,
  canWrite,
  writeDeniedReason,
}: {
  draft: Draft;
  canWrite: boolean;
  writeDeniedReason: string;
}): React.JSX.Element {
  const { form, outcome } = draft;
  return (
    <FormDialog
      open={draft.shown}
      onOpenChange={(open) => {
        if (!open) draft.close();
      }}
      returnFocusRef={draft.returnFocusRef}
      form={form}
      title="피드백 남기기"
      description="이 호출의 품질을 평가합니다. 프롬프트 원문은 입력하지 마세요."
      submitLabel="등록"
      submitDisabled={!canWrite || Boolean(outcome && !draft.canRetry)}
      onSubmit={draft.submit}
    >
      {draft.canRetry ? (
        <InlineNotice tone="warning" title="이전 저장 결과를 확인하세요.">
          저장 완료를 확인하지 못했습니다. 처리 결과를 확인한 뒤 ‘등록’을 눌러 직접 다시 시도할 수 있습니다.
          이미 처리됐다면 중복 등록될 수 있습니다. 자동으로 다시 보내지는 않습니다.
        </InlineNotice>
      ) : outcome ? (
        <InlineNotice tone="warning" title="이미 전송한 피드백입니다.">
          {outcome === "pending"
            ? "이전 요청의 응답을 기다리고 있습니다. "
            : outcome === "acknowledged"
              ? "이전 요청의 응답을 확인했습니다. "
              : "이전 요청의 결과가 불확실합니다. "}
          같은 편집은 다시 전송하지 않습니다. 현재 결과를 확인하고 이 창을 명시적으로 닫은 뒤 새 편집을
          시작하세요.
        </InlineNotice>
      ) : null}
      {!canWrite ? (
        <InlineNotice tone="warning" title="피드백 등록 잠김">
          {writeDeniedReason}
        </InlineNotice>
      ) : null}
      <FormField label="요청 ID" required error={form.formState.errors.request_id?.message}>
        {(control) => <Input {...control} {...form.register("request_id")} disabled={!canWrite} />}
      </FormField>
      <FormField label="평점" required error={form.formState.errors.rating?.message}>
        {(control) => (
          <Select
            {...control}
            {...form.register("rating")}
            disabled={!canWrite}
            options={[
              { value: "1", label: "긍정 (+1)" },
              { value: "0", label: "보통 (0)" },
              { value: "-1", label: "부정 (-1)" },
            ]}
          />
        )}
      </FormField>
      <FormField label="라벨" error={form.formState.errors.label?.message}>
        {(control) => (
          <Input {...control} {...form.register("label")} placeholder="예: 근거 부족" disabled={!canWrite} />
        )}
      </FormField>
      <FormField label="의견" error={form.formState.errors.comment?.message}>
        {(control) => <Textarea {...control} rows={3} {...form.register("comment")} disabled={!canWrite} />}
      </FormField>
    </FormDialog>
  );
}
