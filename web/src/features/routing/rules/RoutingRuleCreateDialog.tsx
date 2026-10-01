import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import type { RoutingCreateAccess } from "./routing-rule-create-access";
import { useRoutingCreateOperation, type CreateReview } from "./routing-rule-create-operation";
import {
  buildRuleCreate,
  createAcknowledgedMessage,
  createFields,
  createReviewChanged,
  createText,
  initialCreateDraft,
  RuleCreateProblem,
  type CreateDraft,
  type CreateField,
} from "./routing-rule-create-state";
import { RoutingRuleCreateFields } from "./RoutingRuleCreateFields";
import "./routing-rule-create.css";

interface Props {
  access: RoutingCreateAccess;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
function Creator({ access, onClose, returnFocusRef }: Props) {
  const [draft, setDraft] = useState<CreateDraft>({ ...initialCreateDraft });
  const latestDraft = useRef(draft);
  const [review, setReview] = useState<CreateReview>();
  const reviewRef = useRef<CreateReview | undefined>(undefined);
  const impactRef = useRef<CreateReview | undefined>(undefined);
  const [impact, setImpact] = useState(false);
  const [error, setError] = useState<RuleCreateProblem | string>();
  const region = useRef<HTMLDivElement>(null);
  const resultRegion = useRef<HTMLDivElement>(null);
  const returnToInput = useRef(false);
  const active = useRef(true);
  const dirty = createFields.some(([field]) => draft[field] !== initialCreateDraft[field]);
  const operation = useRoutingCreateOperation({
    access,
    dirty,
    onClose,
    isReview: (candidate) => reviewRef.current === candidate && impactRef.current === candidate,
  });
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const clearReview = () => {
    reviewRef.current = undefined;
    impactRef.current = undefined;
    setReview(undefined);
    setImpact(false);
  };
  const update = (field: CreateField, value: string) => {
    if (!active.current || operation.pending || operation.acknowledged) return;
    try {
      access.assertRead();
    } catch {
      return;
    }
    const next = { ...latestDraft.current, [field]: value };
    latestDraft.current = next;
    clearReview();
    setDraft(next);
    setError(undefined);
  };
  const prepare = () => {
    if (!active.current || operation.pending || operation.acknowledged || operation.unconfirmed) return;
    setError(undefined);
    try {
      access.assertApproval(access.approval);
      const body = Object.freeze(buildRuleCreate(latestDraft.current, access.prefixes));
      const candidate = Object.freeze({ body, approval: access.approval });
      reviewRef.current = candidate;
      impactRef.current = undefined;
      setImpact(false);
      setReview(candidate);
    } catch (cause) {
      setError(
        cause instanceof RuleCreateProblem
          ? cause
          : "현재 권한과 표시 보호 기준을 확인한 뒤 다시 검토하세요.",
      );
    }
  };
  const edit = () => {
    if (!active.current || operation.pending || operation.acknowledged) return;
    try {
      access.assertRead();
    } catch {
      return;
    }
    returnToInput.current = true;
    clearReview();
    setError(undefined);
  };
  useLayoutEffect(() => {
    if (error instanceof RuleCreateProblem) {
      region.current
        ?.querySelector<HTMLElement>(
          `[data-create-field="${error.field}"] input, [data-create-field="${error.field}"] textarea, [data-create-field="${error.field}"] button`,
        )
        ?.focus();
    } else if (review) {
      const heading = region.current?.querySelector<HTMLElement>("[data-create-heading]");
      heading?.focus();
      heading?.scrollIntoView?.({ block: "start" });
    } else if (returnToInput.current) {
      returnToInput.current = false;
      region.current
        ?.querySelector<HTMLElement>(
          '[data-create-field="match_pattern"] input, [data-create-field="match_pattern"] button',
        )
        ?.focus();
    }
  }, [error, review]);
  useLayoutEffect(() => {
    // Only the first acknowledged transition moves focus. Later list reads
    // preserve the user's place and the shared Dialog keeps close focus policy.
    if (operation.acknowledged) {
      resultRegion.current?.focus();
      resultRegion.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [operation.acknowledged]);
  const validReview = review !== undefined && operation.reviewCurrent(review);
  const retiredReview = review !== undefined && review.approval !== access.approval;
  const text = (value: string | number, empty?: string) => createText(value, access.prefixes, empty);
  const requestId = isAppError(operation.error) ? operation.error.requestId : undefined;
  return (
    <Dialog
      open
      title="라우팅 규칙 추가"
      description="입력값을 검토한 뒤 사용 중인 새 라우팅 규칙의 생성을 요청합니다."
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) operation.close();
      }}
      footer={
        <>
          <Button aria-disabled={operation.pending} onClick={() => operation.close()}>
            {operation.acknowledged ? "닫기" : "취소"}
          </Button>
          {review && !operation.acknowledged ? (
            <Button aria-disabled={operation.pending} onClick={edit}>
              입력 수정
            </Button>
          ) : null}
          {!operation.acknowledged ? (
            review ? (
              <Button
                variant="primary"
                aria-busy={operation.phase === "creating"}
                aria-disabled={
                  operation.pending || operation.unconfirmed || !validReview || !access.write.allowed
                }
                onClick={() => operation.save(review)}
              >
                규칙 만들기
              </Button>
            ) : (
              <Button
                variant="primary"
                aria-disabled={operation.pending || operation.unconfirmed || !access.write.allowed}
                onClick={prepare}
              >
                생성 내용 검토
              </Button>
            )
          ) : null}
        </>
      }
    >
      <div className="routing-rule-create" ref={region}>
        <p>
          새 규칙은 사용 중으로 생성됩니다. 실제 선택은 라우팅 활성 여부·모델 패턴·복잡도·우선순위에 따르며,
          전체 요청에 미칠 영향을 미리 검증한 것은 아닙니다.
        </p>
        <p>
          서버 설정에 따라 후속 모의 검사와 감사 기록이 추가될 수 있습니다. 모든 서버에 즉시 반영되거나 정확히
          한 번 생성됨을 보장하지 않습니다.
        </p>
        {!access.write.allowed ? (
          <InlineNotice tone="warning" title="현재 규칙을 만들 수 없습니다.">
            {access.write.reason}
          </InlineNotice>
        ) : null}
        {typeof error === "string" ? <InlineNotice tone="warning">{error}</InlineNotice> : null}
        {retiredReview && !operation.acknowledged ? (
          <InlineNotice tone="warning">{createReviewChanged}</InlineNotice>
        ) : null}
        {operation.unconfirmed && operation.phase !== "creating" ? (
          <InlineNotice tone="warning" title="생성 여부를 확인하지 못했습니다.">
            목록을 조회해도 이전 요청의 완료 여부는 확정할 수 없습니다. 이 창에서는 다시 생성하지 않습니다.
            창을 닫고 새로 추가하면 중복 규칙이 생길 수 있습니다. 일반 오류에 새 자동 재시도를 추가하지 않으며
            기존 인증 갱신 동작은 유지합니다.
          </InlineNotice>
        ) : null}
        {operation.error ? (
          <InlineNotice
            tone="warning"
            title={
              operation.acknowledged
                ? "생성 요청은 확인했지만 목록을 다시 조회하지 못했습니다."
                : "규칙 조회 또는 생성 응답을 확인하지 못했습니다."
            }
          >
            {safeAppErrorMessage(operation.error, "현재 권한을 확인한 뒤 목록을 수동으로 다시 조회하세요.")}
            {requestId ? <p>요청 ID: {text(requestId)}</p> : null}
          </InlineNotice>
        ) : null}
        {operation.acknowledged ? (
          <div role="region" aria-label="라우팅 규칙 생성 결과" tabIndex={-1} ref={resultRegion}>
            <InlineNotice tone="success" title={createAcknowledgedMessage}>
              서버의 생성 응답을 확인했습니다. 실제 라우팅 적용과 이후 상태는 별도로 확인하세요.
            </InlineNotice>
          </div>
        ) : review ? (
          <section aria-label="새 규칙 생성 내용">
            <h3 tabIndex={-1} data-create-heading>
              생성 내용 검토
            </h3>
            <dl className="routing-rule-create-review">
              <dt>사용 상태</dt>
              <dd>사용 중으로 생성</dd>
              {createFields.map(([field, label]) => (
                <div key={field}>
                  <dt>{label}</dt>
                  <dd>{text(review.body[field], field === "target_provider" ? "자동 선택" : "없음")}</dd>
                </div>
              ))}
            </dl>
            <Checkbox
              label="사용 중으로 생성되는 규칙의 라우팅 영향을 확인했습니다"
              checked={impact && !retiredReview}
              disabled={operation.pending || operation.unconfirmed || retiredReview || !access.write.allowed}
              onChange={(event) => {
                if (
                  !active.current ||
                  operation.pending ||
                  operation.unconfirmed ||
                  reviewRef.current !== review
                )
                  return;
                try {
                  access.assertApproval(review.approval);
                } catch {
                  return;
                }
                impactRef.current = event.target.checked ? review : undefined;
                setImpact(event.target.checked);
              }}
            />
          </section>
        ) : (
          <form
            className="routing-rule-create-fields"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              prepare();
            }}
          >
            <RoutingRuleCreateFields
              draft={draft}
              prefixes={access.prefixes}
              pending={operation.pending}
              error={error instanceof RuleCreateProblem ? error : undefined}
              update={update}
            />
          </form>
        )}
        {operation.pending ? (
          <p role="status">
            {operation.phase === "creating"
              ? "규칙 생성 요청을 보내고 있습니다."
              : operation.acknowledged
                ? "생성 응답은 확인했으며 목록을 다시 조회 중입니다."
                : "규칙 목록을 다시 조회 중입니다."}
          </p>
        ) : null}
        {operation.refreshed && !operation.pending ? <p role="status">목록을 다시 조회했습니다.</p> : null}
        <Button
          aria-disabled={operation.pending || !access.readable}
          aria-busy={operation.phase === "refreshing"}
          onClick={operation.refresh}
        >
          목록 다시 조회
        </Button>
        <div role="region" aria-label="라우팅 규칙 생성 읽기 안내" tabIndex={0}>
          방향키와 Page Up·Page Down 키로 긴 검토 내용을 읽을 수 있습니다. 표시 보호는 서버 저장·감사 기록의
          비밀정보 제거를 뜻하지 않습니다.
        </div>
      </div>
    </Dialog>
  );
}
export function RoutingRuleCreateDialog(props: Props) {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <Creator {...props} />
  ) : (
    <UnsavedChangesProvider>
      <Creator {...props} />
    </UnsavedChangesProvider>
  );
}
