import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import type { RoutingEditAccess } from "./routing-rule-edit-access";
import { useRoutingEditOperation, type RuleReview } from "./routing-rule-edit-operation";
import {
  buildRulePatch,
  changedRuleMessage,
  editFields,
  RuleEditProblem,
  ruleText,
  type RuleEdit,
} from "./routing-rule-edit-state";
import { RoutingRuleEditFields } from "./RoutingRuleEditFields";
import "./routing-rule-edit.css";

interface Props {
  rule: RoutingRule;
  access: RoutingEditAccess;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
function Editor({ rule, access, onClose, returnFocusRef }: Props) {
  const [edit, setEdit] = useState<RuleEdit>({});
  const latestEdit = useRef(edit);
  const [review, setReview] = useState<RuleReview>();
  const reviewRef = useRef<RuleReview | undefined>(undefined);
  const [error, setError] = useState<RuleEditProblem | string>();
  const [unchanged, setUnchanged] = useState(false);
  const region = useRef<HTMLDivElement>(null);
  const dirty = editFields.some(
    ([field]) => edit[field] !== undefined && edit[field] !== String(rule[field]),
  );
  const operation = useRoutingEditOperation({
    baseline: rule,
    access,
    dirty,
    onClose,
    isReview: (candidate) => reviewRef.current === candidate,
  });
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const update = (next: RuleEdit) => {
    if (!active.current || operation.pending || operation.saved) return;
    latestEdit.current = next;
    reviewRef.current = undefined;
    setReview(undefined);
    setEdit(next);
    setError(undefined);
    setUnchanged(false);
  };
  const prepare = () => {
    if (!active.current || operation.pending || operation.saved) return;
    setError(undefined);
    setUnchanged(false);
    try {
      const stamps = operation.capture();
      const patch = buildRulePatch(rule, latestEdit.current, access.prefixes);
      if (!Object.keys(patch).length) {
        setUnchanged(true);
        return;
      }
      const candidate = { patch, approval: access.approval, ...stamps };
      reviewRef.current = candidate;
      setReview(candidate);
    } catch (cause) {
      setError(
        cause instanceof RuleEditProblem ? cause : "현재 권한과 원본 목록을 확인하고 다시 검토하세요.",
      );
    }
  };
  useLayoutEffect(() => {
    if (error instanceof RuleEditProblem) {
      region.current
        ?.querySelector<HTMLElement>(
          `[data-edit-field="${error.field}"] input, [data-edit-field="${error.field}"] textarea, [data-edit-field="${error.field}"] button`,
        )
        ?.focus();
    } else if (review) {
      const heading = region.current?.querySelector<HTMLElement>("[data-review-heading]");
      heading?.focus();
      heading?.scrollIntoView?.({ block: "start" });
    }
  }, [error, review]);
  const validReview = review !== undefined && operation.reviewCurrent(review);
  const cause = operation.error ?? operation.query.error;
  const requestId = isAppError(cause) ? cause.requestId : undefined;
  const loaded = operation.query.data !== undefined;
  const text = (value: string | number, empty?: string) => ruleText(String(value), access.prefixes, empty);
  return (
    <Dialog
      open
      title="라우팅 규칙 수정"
      description="현재 원본과 변경할 값을 검토한 뒤 같은 규칙을 수정합니다. 사용 상태는 변경하지 않습니다."
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) operation.close();
      }}
      footer={
        <>
          <Button aria-disabled={operation.pending} onClick={() => operation.close()}>
            {operation.saved ? "닫기" : "취소"}
          </Button>
          {review && !operation.saved ? (
            <Button
              disabled={operation.pending}
              onClick={() => {
                if (!active.current || operation.pending) return;
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
                aria-busy={operation.pending}
                aria-disabled={
                  operation.pending ||
                  operation.unconfirmed ||
                  !access.write.allowed ||
                  !validReview ||
                  !operation.ready
                }
                onClick={() => operation.save(review)}
              >
                규칙 저장
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={operation.pending || !access.write.allowed || !operation.ready}
                onClick={prepare}
              >
                변경 내용 검토
              </Button>
            )
          ) : null}
        </>
      }
    >
      <div className="routing-rule-edit" ref={region}>
        <p>
          저장 직전에 다시 조회하지만, 동시에 발생한 다른 변경까지 막을 수는 없습니다. 사용 중인 규칙의 수정은
          실제 라우팅에 영향을 줄 수 있습니다.
        </p>
        <p>
          서버 설정에 따라 후속 모의 검사와 감사 기록이 추가될 수 있습니다. 모든 서버에 즉시 반영되는 것은
          아닙니다.
        </p>
        <dl className="routing-rule-edit-identity">
          <dt>원본 규칙 ID</dt>
          <dd>{text(rule.id)}</dd>
          <dt>검토 기준 사용 상태</dt>
          <dd>{rule.enabled ? "사용 중" : "중지됨"}</dd>
        </dl>
        {!access.write.allowed ? (
          <InlineNotice tone="warning" title="현재 규칙을 저장할 수 없습니다.">
            {access.write.reason}
          </InlineNotice>
        ) : null}
        {unchanged ? (
          <InlineNotice title="변경된 내용이 없습니다.">저장 요청을 보내지 않았습니다.</InlineNotice>
        ) : null}
        {typeof error === "string" ? <InlineNotice tone="warning">{error}</InlineNotice> : null}
        {loaded && !operation.sourceMatches && !operation.saved ? (
          <InlineNotice tone="warning">{changedRuleMessage}</InlineNotice>
        ) : null}
        {review && !validReview && !operation.saved ? (
          <InlineNotice tone="warning">
            검토한 목록 기준이 바뀌었습니다. 다시 편집으로 돌아가 검토하세요.
          </InlineNotice>
        ) : null}
        {operation.unconfirmed && operation.phase !== "saving" ? (
          <InlineNotice tone="warning" title="저장 여부를 확인하지 못했습니다.">
            현재 값을 조회해도 이전 요청의 완료 여부는 확정할 수 없습니다. 이 창에서는 다시 저장하지 않습니다.
            닫은 뒤 최신 목록에서 새로 편집하세요. 일반 오류에 새 자동 재시도를 추가하지 않으며 기존 인증 갱신
            동작은 유지합니다.
          </InlineNotice>
        ) : null}
        {cause ? (
          <InlineNotice
            tone="warning"
            title={
              operation.saved
                ? "저장은 완료했지만 목록을 다시 조회하지 못했습니다."
                : "규칙 조회 또는 저장 응답을 확인하지 못했습니다."
            }
          >
            {isAppError(cause) && cause.code === "routing_edit_source_changed"
              ? changedRuleMessage
              : safeAppErrorMessage(cause, "현재 목록과 권한을 확인한 뒤 수동으로 다시 조회하세요.")}
            {requestId ? <p>요청 ID: {text(requestId)}</p> : null}
          </InlineNotice>
        ) : null}
        {operation.saved ? (
          <InlineNotice tone="success" title="라우팅 규칙을 저장했습니다.">
            서버의 저장 응답을 확인했습니다. 이후 다른 요청이 값을 변경할 수 있습니다.
          </InlineNotice>
        ) : review ? (
          <section aria-label="규칙 변경 비교">
            <h3 tabIndex={-1} data-review-heading>
              변경 전후
            </h3>
            <table>
              <thead>
                <tr>
                  <th scope="col">항목</th>
                  <th scope="col">현재 저장값</th>
                  <th scope="col">저장할 값</th>
                </tr>
              </thead>
              <tbody>
                {editFields.map(([field, label]) => (
                  <tr key={field}>
                    <th scope="row">{label}</th>
                    <td>{text(rule[field], field === "target_provider" ? "자동 선택" : "없음")}</td>
                    <td>
                      {text(
                        review.patch[field] ?? rule[field],
                        field === "target_provider" ? "자동 선택" : "없음",
                      )}
                      {review.patch[field] === undefined ? " (유지)" : " (변경)"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : loaded ? (
          <fieldset
            disabled={operation.pending || !operation.sourceMatches}
            className="routing-rule-edit-fields"
          >
            <legend className="sr-only">라우팅 규칙 편집 항목</legend>
            <RoutingRuleEditFields
              baseline={rule}
              edit={edit}
              prefixes={access.prefixes}
              error={error instanceof RuleEditProblem ? error : undefined}
              update={update}
            />
          </fieldset>
        ) : operation.query.isPending ? (
          <p role="status">원본 규칙을 확인하고 있습니다.</p>
        ) : null}
        {operation.pending ? (
          <p role="status">
            {operation.phase === "saving"
              ? "규칙을 저장 중입니다."
              : operation.saved
                ? "저장은 확인했으며 목록을 다시 조회 중입니다."
                : "현재 원본을 확인 중입니다."}
          </p>
        ) : null}
        <Button
          aria-disabled={operation.pending || operation.query.isFetching || !access.readable}
          aria-busy={operation.phase === "refreshing"}
          onClick={() => {
            if (!operation.query.isFetching) operation.refresh();
          }}
        >
          목록 다시 조회
        </Button>
        <div role="region" aria-label="라우팅 규칙 편집 읽기 안내" tabIndex={0}>
          방향키와 Page Up·Page Down 키로 긴 비교 내용을 읽을 수 있습니다. 표시 보호는 서버 저장·감사 기록의
          비밀정보 제거를 뜻하지 않습니다.
        </div>
      </div>
    </Dialog>
  );
}
export function RoutingRuleEditDialog(props: Props) {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <Editor {...props} />
  ) : (
    <UnsavedChangesProvider>
      <Editor {...props} />
    </UnsavedChangesProvider>
  );
}
