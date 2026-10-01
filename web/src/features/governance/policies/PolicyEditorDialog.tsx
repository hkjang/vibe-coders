import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Policy } from "@/shared/api/domains/governance";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import type { PolicyEditorAccess } from "./policy-editor-access";
import { usePolicyEditorOperation, type PolicyReview } from "./policy-editor-operation";
import { editorText, fingerprint } from "./policy-editor-security";
import {
  buildPolicy,
  changed,
  EditProblem,
  initialEdit,
  policyProblem,
  type PolicyEdit,
} from "./policy-editor-state";
import { PolicyEditorFields } from "./PolicyEditorFields";
import { PolicyEditorReview } from "./PolicyEditorReview";
import "./policy-editor.css";

interface Props {
  baseline: Policy;
  access: PolicyEditorAccess;
  close: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
function Editor({ baseline, access, close, returnFocusRef }: Props) {
  const [edit, setEdit] = useState(() => initialEdit(baseline));
  const latestEdit = useRef(edit);
  const [review, setReview] = useState<PolicyReview>();
  const reviewRef = useRef<PolicyReview | undefined>(undefined);
  const [error, setError] = useState<EditProblem>();
  const [unchanged, setUnchanged] = useState(false);
  const form = useRef<HTMLDivElement>(null);
  const dirty = fingerprint(edit) !== fingerprint(initialEdit(baseline));
  const operation = usePolicyEditorOperation({
    baseline,
    access,
    dirty,
    close,
    isReview: (candidate) => reviewRef.current === candidate,
  });
  const update = (next: PolicyEdit) => {
    if (operation.pending) return;
    latestEdit.current = next;
    reviewRef.current = undefined;
    setReview(undefined);
    setEdit(next);
    setError(undefined);
    setUnchanged(false);
  };
  const prepare = () => {
    if (operation.pending || operation.saved) return;
    setError(undefined);
    setUnchanged(false);
    try {
      access.assertRead();
      access.write.assertCurrent();
      access.assertPrefixes(access.prefixKey);
      const body = buildPolicy(baseline, latestEdit.current, access.prefixes);
      if (!changed(baseline, body)) {
        setUnchanged(true);
        return;
      }
      const candidate = { body, prefixKey: access.prefixKey, approval: access.approval };
      reviewRef.current = candidate;
      setReview(candidate);
    } catch (cause) {
      setError(
        cause instanceof EditProblem
          ? cause
          : new EditProblem("policy", "현재 실행 권한과 원본을 확인하세요."),
      );
    }
  };
  useLayoutEffect(() => {
    if (error) {
      const target = form.current?.querySelector<HTMLElement>(`[data-editor-field="${error.field}"]`);
      (target?.querySelector<HTMLElement>("input,textarea,button") ?? target)?.focus();
    } else if (review) form.current?.querySelector<HTMLElement>("[data-editor-review-heading]")?.focus();
  }, [error, review]);
  const validReview = review && review.prefixKey === access.prefixKey && review.approval === access.approval;
  const sourceProblem = policyProblem(baseline);
  const cause = operation.error?.cause;
  const requestId = isAppError(cause) ? cause.requestId : undefined;
  const conflict = isAppError(cause) && cause.code === "editor_source_changed";
  return (
    <Dialog
      open
      title="비활성 정책 편집"
      description="원본 정책과 규칙 전체를 고정하여 검토합니다. 저장해도 정책은 활성화하지 않습니다."
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) operation.close();
      }}
      footer={
        <>
          <Button aria-disabled={operation.pending} onClick={() => operation.close()}>
            {operation.saved ? "닫기" : "취소"}
          </Button>
          {!operation.saved && review ? (
            <Button
              disabled={operation.pending}
              onClick={() => {
                reviewRef.current = undefined;
                setReview(undefined);
              }}
            >
              다시 편집
            </Button>
          ) : null}
          {!operation.saved ? (
            review ? (
              <Button
                variant="primary"
                aria-disabled={
                  operation.pending || operation.unconfirmed || !access.write.allowed || !validReview
                }
                aria-busy={operation.pending}
                onClick={() => operation.save(review)}
              >
                검토한 내용 저장
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={operation.pending || !access.write.allowed || !!sourceProblem}
                onClick={prepare}
              >
                변경 내용 검토
              </Button>
            )
          ) : null}
        </>
      }
    >
      <div className="policy-editor" ref={form}>
        <p>
          저장 직전에 다시 조회하지만, 동시에 발생한 다른 변경까지 막을 수는 없습니다. 서버 설정에 따라 후속
          모의 검사와 감사 기록이 추가될 수 있습니다.
        </p>
        {!access.write.allowed ? (
          <InlineNotice tone="warning" title="현재 정책을 저장할 수 없습니다.">
            {access.write.reason}
          </InlineNotice>
        ) : null}
        {sourceProblem ? (
          <InlineNotice tone="warning" title="원본 확인이 필요합니다.">
            {sourceProblem}
          </InlineNotice>
        ) : null}
        {error?.field === "policy" ? <InlineNotice tone="danger">{error.message}</InlineNotice> : null}
        {unchanged ? (
          <InlineNotice title="변경된 내용이 없습니다.">저장 요청을 보내지 않았습니다.</InlineNotice>
        ) : null}
        {review && !validReview ? (
          <InlineNotice tone="warning">
            실행 권한 또는 표시 보호 기준이 바뀌었습니다. 다시 편집으로 돌아가 검토하세요.
          </InlineNotice>
        ) : null}
        {operation.unconfirmed && operation.phase !== "saving" ? (
          <InlineNotice tone="warning" title="저장 여부를 확인할 수 없습니다.">
            저장되었을 수 있어 다시 저장을 잠갔습니다. 목록 다시 조회로 원본이 그대로인지 확인한 뒤에만 다시
            저장할 수 있습니다. 원본이 바뀌었다면 닫은 뒤 최신 목록에서 다시 편집하세요. 일반 오류에 자동
            재시도를 추가하지 않으며, 기존 인증 갱신 동작은 유지합니다.
          </InlineNotice>
        ) : null}
        {operation.error ? (
          <InlineNotice
            tone="warning"
            title={
              operation.saved
                ? "저장은 완료했지만 목록을 갱신하지 못했습니다."
                : operation.unconfirmed
                  ? undefined
                  : "저장 전 원본을 확인하지 못했습니다."
            }
          >
            {conflict
              ? "원본이 바뀌었거나 현재 목록이 확정되지 않았습니다. 최신 목록을 확인하고 닫은 뒤 다시 편집하세요."
              : safeAppErrorMessage(cause, "잠시 후 수동으로 다시 확인하세요.")}
            {requestId ? <p>요청 ID: {editorText(requestId, access.prefixes)}</p> : null}
          </InlineNotice>
        ) : null}
        {operation.saved ? (
          <InlineNotice tone="success" title="비활성 정책을 저장했습니다.">
            서버의 저장 응답을 확인했습니다. 활성화는 별도 작업입니다. 이후 다른 사용자가 정책을 바꿀 수
            있습니다.
          </InlineNotice>
        ) : review ? (
          <PolicyEditorReview baseline={baseline} body={review.body} prefixes={access.prefixes} />
        ) : (
          <fieldset className="policy-editor-fields" disabled={operation.pending}>
            <PolicyEditorFields
              baseline={baseline}
              edit={edit}
              prefixes={access.prefixes}
              error={error}
              update={update}
            />
          </fieldset>
        )}
        {operation.pending ? (
          <p role="status">
            {operation.phase === "saving"
              ? "정책을 저장 중입니다."
              : operation.saved
                ? "저장은 확인했으며 목록을 갱신 중입니다. 완료 후 닫을 수 있습니다."
                : "최신 원본을 확인 중입니다."}
          </p>
        ) : null}
        <Button
          aria-disabled={operation.pending || !access.read}
          aria-busy={operation.phase === "refreshing"}
          onClick={operation.refresh}
        >
          목록 다시 조회
        </Button>
        <div role="region" aria-label="정책 편집 읽기 안내" tabIndex={0}>
          방향키와 Page Up·Page Down 키로 긴 규칙과 비교 내용을 읽을 수 있습니다. 원문 표시 보호는 서버
          저장·감사 기록의 비밀정보 제거를 뜻하지 않습니다.
        </div>
      </div>
    </Dialog>
  );
}
export function PolicyEditorDialog(props: Props) {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <Editor {...props} />
  ) : (
    <UnsavedChangesProvider>
      <Editor {...props} />
    </UnsavedChangesProvider>
  );
}
