import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import type { RoutingDeleteAccess } from "./routing-rule-delete-access";
import { useRoutingDeleteOperation, type DeleteReview } from "./routing-rule-delete-operation";
import {
  deleteConfirmation,
  deleteFields,
  deleteReviewChanged,
  deleteSourceChanged,
} from "./routing-rule-delete-state";
import { ruleText } from "./routing-rule-edit-state";
import "./routing-rule-delete.css";

interface Props {
  rule: RoutingRule;
  access: RoutingDeleteAccess;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
function DeleteConfirmation({ rule, access, onClose, returnFocusRef }: Props) {
  const [phrase, setPhrase] = useState("");
  const [impact, setImpact] = useState(false);
  const input = useRef({ phrase: "", impact: false });
  const [review, setReview] = useState<DeleteReview>();
  const reviewRef = useRef<DeleteReview | undefined>(undefined);
  const typedReview = useRef<DeleteReview | undefined>(undefined);
  const [confirmationError, setConfirmationError] = useState(false);
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const operation = useRoutingDeleteOperation({
    baseline: rule,
    access,
    onClose,
    isReview: (candidate) =>
      reviewRef.current === candidate &&
      input.current.phrase === deleteConfirmation &&
      (!rule.enabled || input.current.impact),
  });
  const update = (next: { phrase: string; impact: boolean }) => {
    if (
      !active.current ||
      !operation.ready ||
      operation.pending ||
      operation.acknowledged ||
      operation.unconfirmed
    )
      return;
    const phraseChanged = next.phrase !== input.current.phrase;
    input.current = next;
    setPhrase(next.phrase);
    setImpact(next.impact);
    reviewRef.current = undefined;
    setReview(undefined);
    setConfirmationError(false);
    if (phraseChanged) typedReview.current = undefined;
    if (next.phrase !== deleteConfirmation) return;
    try {
      // Only explicit text re-entry can approve a newer query/permission generation.
      if (phraseChanged) typedReview.current = operation.capture();
      if (rule.enabled && !next.impact) return;
      const candidate = typedReview.current;
      if (!candidate) {
        setConfirmationError(true);
        return;
      }
      reviewRef.current = candidate;
      setReview(candidate);
    } catch {
      setConfirmationError(true);
    }
  };
  const validReview = review !== undefined && operation.reviewCurrent(review);
  const cause = operation.error ?? operation.query.error;
  const requestId = isAppError(cause) ? cause.requestId : undefined;
  const text = (value: string | number, empty?: string) => ruleText(String(value), access.prefixes, empty);
  const loaded = operation.query.data !== undefined;
  const locked = operation.pending || operation.acknowledged || operation.unconfirmed;
  return (
    <Dialog
      open
      title="라우팅 규칙 삭제"
      description="고정된 원본 규칙과 삭제 영향을 검토하고 확인 문구를 입력하세요."
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) operation.close();
      }}
      footer={
        <>
          <Button aria-disabled={operation.pending} onClick={() => operation.close()}>
            {operation.acknowledged ? "닫기" : "취소"}
          </Button>
          {!operation.acknowledged ? (
            <Button
              variant="danger"
              aria-busy={operation.pending}
              aria-disabled={locked || !validReview || !operation.ready || !access.write.allowed}
              onClick={() => {
                if (review) operation.remove(review);
              }}
            >
              규칙 삭제
            </Button>
          ) : null}
        </>
      }
    >
      <div className="routing-rule-delete">
        <p>
          사용 중인 규칙을 삭제하면 실제 라우팅에 영향을 줄 수 있습니다. 다른 규칙과 설정에 따른 전체 영향은
          이 화면에서 확인하지 않습니다.
        </p>
        <p>
          삭제 직전에 다시 조회하지만 동시에 발생하는 변경까지 막지는 못합니다. 서버의 삭제 응답은 실제로 한
          행이 삭제되었거나 이 요청만 실행되었다는 보장이 아닙니다.
        </p>
        <p>
          서버 설정에 따라 후속 모의 검사와 감사 기록이 추가될 수 있으며 모든 서버에 즉시 반영되는 것은
          아닙니다.
        </p>
        <section aria-label="삭제할 원본 규칙">
          <h3>삭제할 원본 규칙</h3>
          <dl>
            {deleteFields.map(([field, label]) => (
              <div key={field}>
                <dt>{label}</dt>
                <dd>
                  {field === "enabled"
                    ? rule.enabled
                      ? "사용 중"
                      : "중지됨"
                    : text(rule[field], field === "target_provider" ? "자동 선택" : "없음")}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        {!access.write.allowed ? (
          <InlineNotice tone="warning" title="현재 규칙을 삭제할 수 없습니다.">
            {access.write.reason}
          </InlineNotice>
        ) : null}
        {loaded && !operation.sourceMatches && !operation.acknowledged ? (
          <InlineNotice tone="warning">{deleteSourceChanged}</InlineNotice>
        ) : null}
        {(confirmationError || (review && !validReview)) && !operation.acknowledged ? (
          <InlineNotice tone="warning">{deleteReviewChanged}</InlineNotice>
        ) : null}
        {operation.unconfirmed && operation.phase !== "deleting" ? (
          <InlineNotice tone="warning" title="삭제 여부를 확인하지 못했습니다.">
            현재 목록을 조회해도 이전 요청의 완료 여부는 확정할 수 없습니다. 이 창에서는 다시 삭제하지
            않습니다. 창을 닫고 최신 목록에서 새로 선택해 검토하세요. 일반 오류에 새 자동 재시도를 추가하지
            않으며 기존 인증 갱신 동작은 유지합니다.
          </InlineNotice>
        ) : null}
        {cause ? (
          <InlineNotice
            tone="warning"
            title={
              operation.acknowledged
                ? "삭제 요청은 확인했지만 목록을 다시 조회하지 못했습니다."
                : "규칙 조회 또는 삭제 응답을 확인하지 못했습니다."
            }
          >
            {isAppError(cause) && cause.code === "routing_delete_source_changed"
              ? deleteSourceChanged
              : text(safeAppErrorMessage(cause, "현재 목록과 권한을 확인한 뒤 수동으로 다시 조회하세요."))}
            {requestId ? <p>요청 ID: {text(requestId)}</p> : null}
          </InlineNotice>
        ) : null}
        {operation.acknowledged ? (
          <InlineNotice tone="success" title="라우팅 규칙 삭제 요청을 확인했습니다.">
            서버에서 이 규칙 ID에 대한 삭제 응답을 받았습니다. 이후 조회 결과는 다른 요청의 변경도 포함할 수
            있습니다.
          </InlineNotice>
        ) : (
          <div className="routing-rule-delete-confirmation">
            <FormField label="삭제 확인 문구" description="계속하려면 ‘규칙 삭제’를 정확히 입력하세요.">
              {(control) => (
                <Input
                  {...control}
                  value={phrase}
                  readOnly={locked || !operation.ready}
                  aria-disabled={locked || !operation.ready}
                  autoComplete="off"
                  onChange={(event) => update({ ...input.current, phrase: event.target.value })}
                />
              )}
            </FormField>
            {rule.enabled ? (
              <Checkbox
                label="사용 중인 규칙의 라우팅 영향을 확인했습니다"
                checked={impact}
                disabled={locked || !operation.ready}
                onChange={(event) => update({ ...input.current, impact: event.target.checked })}
              />
            ) : null}
            {!operation.ready ? (
              <p role="status">현재 원본 목록을 정상 조회한 뒤 확인 문구를 입력할 수 있습니다.</p>
            ) : null}
          </div>
        )}
        {operation.pending || operation.query.isFetching ? (
          <p role="status">
            {operation.phase === "deleting"
              ? "규칙 삭제 요청 중입니다."
              : operation.acknowledged
                ? "삭제 요청은 확인했으며 목록을 다시 조회 중입니다."
                : "현재 원본을 확인 중입니다."}
          </p>
        ) : null}
        <Button
          aria-disabled={operation.pending || operation.query.isFetching || !access.readable}
          aria-busy={operation.phase === "refreshing"}
          onClick={operation.refresh}
        >
          목록 다시 조회
        </Button>
        <div role="region" aria-label="라우팅 규칙 삭제 읽기 안내" tabIndex={0}>
          방향키와 Page Up·Page Down 키로 긴 내용을 읽을 수 있습니다. 표시 보호는 서버 저장·감사 기록의
          비밀정보 제거를 뜻하지 않습니다.
        </div>
      </div>
    </Dialog>
  );
}
export function RoutingRuleDeleteDialog(props: Props) {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <DeleteConfirmation {...props} />
  ) : (
    <UnsavedChangesProvider>
      <DeleteConfirmation {...props} />
    </UnsavedChangesProvider>
  );
}
