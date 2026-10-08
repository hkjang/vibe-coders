import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";

import {
  confirmedRequestNote,
  requestNoteDefaults,
  requestNoteFormSchema,
  requestNoteKey,
  type RequestNoteValues,
} from "./request-note-state";
import { RequestNoteNotices } from "./RequestNoteNotices";
import type { RequestNoteDraft, RequestNoteEditor, useRequestNoteQuery } from "./use-request-note-editor";
import { AppError } from "@/shared/api/error";
import type { RequestNote } from "@/shared/api/domains/observability.schemas";
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
  const [recovery] = useState(() => editor.retainedDraft);
  const form = useZodForm<RequestNoteValues, RequestNoteValues>(
    requestNoteFormSchema,
    recovery
      ? { noteMode: "preserve", tagsMode: "preserve", note: "", tags: "" }
      : requestNoteDefaults(target.baseline),
  );
  const client = useQueryClient();
  const [receipt, setReceipt] = useState<{ query: Query<RequestNote>; count: number }>();
  const mounted = useRef(false);
  const wasDirty = useRef(Boolean(recovery?.dirty));
  const hydrating = useRef(Boolean(recovery));
  const refetch = current.query.refetch;
  const readRecovery = useCallback(async () => {
    if (!target.retention?.isCurrent()) return;
    const key = requestNoteKey(target.requestId, target.epoch, target.retention?.readScope);
    const before = client.getQueryCache().find<RequestNote>({ queryKey: key, exact: true });
    const count = before?.state.dataUpdateCount ?? 0;
    try {
      // Join a mount-triggered GET if present; an idle cached success is insufficient.
      await refetch({ cancelRefetch: false, throwOnError: true });
      if (!mounted.current || !target.retention.isCurrent()) return;
      const after = client.getQueryCache().find<RequestNote>({ queryKey: key, exact: true });
      if (
        after &&
        confirmedRequestNote(after.state, target.requestId) &&
        (after !== before || after.state.dataUpdateCount > count)
      )
        setReceipt({ query: after, count: after.state.dataUpdateCount });
    } catch {
      // The existing note notices and explicit GET recovery remain the error UI.
    }
  }, [client, refetch, target]);
  const retain = editor.retain;
  useLayoutEffect(() => {
    mounted.current = true;
    if (recovery) {
      form.reset({ note: "", tags: "", ...recovery.values }, { keepDefaultValues: true });
      void Promise.resolve().then(readRecovery);
    }
    return () => {
      mounted.current = false;
      retain(target, form.getValues(), wasDirty.current);
    };
  }, [form, readRecovery, recovery, retain, target]);
  const dirty = form.formState.isDirty;
  const { setDirty } = editor;
  useLayoutEffect(() => {
    wasDirty.current = dirty || (hydrating.current && Boolean(recovery?.dirty));
    hydrating.current = false;
    setDirty(wasDirty.current);
  }, [dirty, recovery, setDirty]);
  const freshRecovery = () => {
    if (!recovery) return true;
    const query = client.getQueryCache().find<RequestNote>({
      queryKey: requestNoteKey(target.requestId, target.epoch, target.retention?.readScope),
      exact: true,
    });
    return (
      target.retention?.isCurrent() &&
      receipt &&
      query === receipt.query &&
      query.state.dataUpdateCount >= receipt.count &&
      Boolean(confirmedRequestNote(query.state, target.requestId))
    );
  };
  const fresh = freshRecovery();
  const baseline = recovery ? (fresh ? current.confirmed : undefined) : target.baseline;
  const outcome = editor.retainedDraft?.outcome;
  const transmitted = Boolean(outcome && outcome !== "none");
  const deleting = target.kind === "delete";
  const modes = { note: form.watch("noteMode"), tags: form.watch("tagsMode") };
  const confirmed =
    editor.supported && Boolean(current.confirmed) && (!deleting || current.confirmed?.exists) && fresh;
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
      open={!recovery || !editor.awaitingParentDecision}
      form={form}
      title={deleting ? "요청 태그·메모 삭제" : "요청 메모·태그 수정"}
      description={
        deleting
          ? "이 요청에 저장된 태그와 메모를 모두 삭제합니다. 요청 로그는 삭제하지 않습니다."
          : "프롬프트 원문이나 비밀값을 입력하지 마세요. 유지한 필드는 저장 시점의 서버 원본을 보존합니다."
      }
      submitLabel={deleting ? "태그·메모 삭제" : "메모·태그 저장"}
      submitDisabled={!canWrite || !confirmed || transmitted || Boolean(target.retention && editor.pending)}
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) editor.close(target.instance);
      }}
      onSubmit={(values) => {
        if (!canWrite) throw new AppError("요청 메모 쓰기 권한이 없습니다.", { kind: "permission" });
        if (!freshRecovery())
          throw new AppError("현재 메모를 다시 조회한 뒤 편집을 이어가세요.", { kind: "contract" });
        return editor.submit(target, values);
      }}
    >
      <p className="request-note-value">요청 ID: {target.requestId}</p>
      <RequestNoteNotices supported={editor.supported} current={current} />
      {recovery ? (
        <InlineNotice tone="info" title="미저장 초안을 복구했습니다.">
          사용자 입력은 유지했습니다. 현재 메모를 새로 확인하기 전에는 이전 서버 자료를 표시하거나 저장하지
          않습니다.
        </InlineNotice>
      ) : null}
      {transmitted ? (
        <InlineNotice
          tone="warning"
          title={
            outcome === "acknowledged"
              ? "이전에 보낸 저장 요청을 확인했습니다."
              : "이전에 보낸 저장 요청의 결과를 확인하세요."
          }
        >
          같은 초안을 다시 전송하지 않습니다. 현재 메모를 조회해 결과를 확인하세요. 새로 변경하려면 이 편집을
          명시적으로 닫은 뒤 다시 시작하세요.
        </InlineNotice>
      ) : null}
      {editor.recipientUnsupported ? (
        <InlineNotice tone="warning" title="저장 요청을 받은 서버가 안전한 편집을 지원하지 않습니다.">
          구버전 서버가 포함되어 있는지 확인하고 업그레이드한 뒤 다시 조회하세요. 다른 저장 방식으로 자동
          재전송하지 않습니다. 초안은 유지됩니다.
        </InlineNotice>
      ) : null}
      <Button
        size="small"
        disabled={editor.pending || current.query.isFetching}
        onClick={() => (recovery ? void readRecovery() : void current.query.refetch())}
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
        const masked = baseline?.redacted_fields.includes(field) ?? true;
        return (
          <div className="form-grid request-note-field" key={field}>
            <p className="request-note-value">
              {recovery ? "재조회한" : "기존"} {label}:{" "}
              {!baseline
                ? "현재 메모 조회 확인이 필요합니다."
                : field === "note"
                  ? baseline.note || "내용 없음"
                  : baseline.tags.join(", ") || "태그 없음"}
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
