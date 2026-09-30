import { useLayoutEffect } from "react";

import { requestNoteDefaults, requestNoteFormSchema, type RequestNoteValues } from "./request-note-state";
import { RequestNoteNotices } from "./RequestNoteNotices";
import type { RequestNoteDraft, RequestNoteEditor, useRequestNoteQuery } from "./use-request-note-editor";
import { AppError } from "@/shared/api/error";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";

export function RequestNoteDialog({
  target,
  editor,
  current,
  canWrite,
}: {
  target: RequestNoteDraft;
  editor: RequestNoteEditor;
  current: ReturnType<typeof useRequestNoteQuery>;
  canWrite: boolean;
}): React.JSX.Element {
  const form = useZodForm<RequestNoteValues, RequestNoteValues>(
    requestNoteFormSchema,
    requestNoteDefaults(target.baseline),
  );
  const dirty = form.formState.isDirty;
  const { setDirty } = editor;
  useLayoutEffect(() => setDirty(dirty), [dirty, setDirty]);
  const deleting = target.kind === "delete";
  const modes = { note: form.watch("noteMode"), tags: form.watch("tagsMode") };
  const confirmed =
    editor.supported && Boolean(current.confirmed) && (!deleting || current.confirmed?.exists);
  const returnFocusRef = {
    // Read at close, after invalidation may disable the original trigger. Keep
    // focus inside a surviving parent Sheet instead of the inert page behind it.
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
      title={deleting ? "요청 태그·메모 삭제" : "요청 메모·태그 수정"}
      description={
        deleting
          ? "이 요청에 저장된 태그와 메모를 모두 삭제합니다. 요청 로그는 삭제하지 않습니다."
          : "프롬프트 원문이나 비밀값을 입력하지 마세요. 유지한 필드는 저장 시점의 서버 원본을 보존합니다."
      }
      submitLabel={deleting ? "태그·메모 삭제" : "메모·태그 저장"}
      submitDisabled={!canWrite || !confirmed}
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) editor.close(target.instance);
      }}
      onSubmit={(values) => {
        if (!canWrite) throw new AppError("요청 메모 쓰기 권한이 없습니다.", { kind: "permission" });
        return editor.submit(target, values);
      }}
    >
      <p className="request-note-value">요청 ID: {target.requestId}</p>
      <RequestNoteNotices supported={editor.supported} current={current} />
      {editor.recipientUnsupported ? (
        <InlineNotice tone="warning" title="저장 요청을 받은 서버가 안전한 편집을 지원하지 않습니다.">
          구버전 서버가 포함되어 있는지 확인하고 업그레이드한 뒤 다시 조회하세요. 다른 저장 방식으로 자동
          재전송하지 않습니다. 초안은 유지됩니다.
        </InlineNotice>
      ) : null}
      <Button
        size="small"
        disabled={editor.pending || current.query.isFetching}
        onClick={() => void current.query.refetch()}
      >
        현재 메모·태그 다시 조회
      </Button>
      {!canWrite ? (
        <InlineNotice tone="warning">
          {editor.writeDisabledReason ?? "요청 메모 작성에는 admin:write 권한이 필요합니다."}
        </InlineNotice>
      ) : null}
      <p>
        조회가 갱신되어도 이 초안은 바뀌지 않습니다. 다른 관리자의 동시 변경을 막거나 이미 보낸 저장을
        취소하는 기능은 아닙니다.
      </p>
      {deleting ? (
        <InlineNotice tone="warning">
          메모가 비어 있어도 저장된 태그를 함께 삭제합니다. 마스킹되어 보이지 않는 원본도 삭제됩니다.
        </InlineNotice>
      ) : null}
      {(["note", "tags"] as const).map((field) => {
        const label = field === "note" ? "메모" : "태그";
        const masked = target.baseline.redacted_fields.includes(field);
        return (
          <div className="form-grid request-note-field" key={field}>
            <p className="request-note-value">
              기존 {label}:{" "}
              {field === "note"
                ? target.baseline.note || "내용 없음"
                : target.baseline.tags.join(", ") || "태그 없음"}
            </p>
            {masked ? (
              <InlineNotice tone="info">
                {label}의 일부가 마스킹되었습니다. 유지하면 원본을 보존합니다. 전체 교체는 표시된 값에 이어
                쓰지 않고 새 내용으로 바꿉니다.
              </InlineNotice>
            ) : null}
            {!deleting ? (
              <>
                <FormField label={`${label} 변경 방법`}>
                  {(control) => (
                    <Select
                      {...control}
                      value={modes[field]}
                      disabled={!canWrite}
                      options={[
                        { value: "preserve", label: "유지" },
                        { value: "replace", label: "전체 교체" },
                        { value: "clear", label: "비우기" },
                      ]}
                      onChange={(event) => {
                        const mode = event.target.value as RequestNoteValues["noteMode"];
                        form.setValue(`${field}Mode`, mode, { shouldDirty: true });
                        if (mode === "replace" && masked) form.setValue(field, "", { shouldDirty: true });
                      }}
                    />
                  )}
                </FormField>
                {modes[field] === "replace" ? (
                  <FormField
                    label={`새 ${label}`}
                    description={
                      field === "tags"
                        ? "쉼표로 구분합니다. 예: 지연, 재현필요"
                        : "기존 메모 전체를 이 내용으로 교체합니다."
                    }
                    error={form.formState.errors[field]?.message}
                  >
                    {(control) =>
                      field === "note" ? (
                        <Textarea {...control} {...form.register(field)} rows={4} disabled={!canWrite} />
                      ) : (
                        <Input {...control} {...form.register(field)} disabled={!canWrite} />
                      )
                    }
                  </FormField>
                ) : null}
                {modes[field] === "clear" ? (
                  <InlineNotice tone="warning">
                    저장하면 기존 {label}를 모두 비웁니다. 마스킹된 원본도 보존하지 않습니다.
                  </InlineNotice>
                ) : null}
              </>
            ) : null}
          </div>
        );
      })}
    </FormDialog>
  );
}
