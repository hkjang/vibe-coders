import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import type { DomainReviewAccess } from "./domain-review-access";
import { useDomainReviewOperation, type DomainReviewReview } from "./domain-review-operation";
import type { DomainReviewQuery } from "./domain-review-query";
import {
  currentDomainReview,
  domainReviewAcknowledged,
  domainReviewChanged,
  domainReviewFields,
  domainReviewStatusLabels,
  domainReviewStatusText,
  domainReviewText,
  domainReviewUnconfirmed,
} from "./domain-review-state";
import "./domain-review.css";

interface Props {
  access: DomainReviewAccess;
  query: DomainReviewQuery;
  initialReview: DomainReviewReview;
  assertSelected: () => void;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
function ReviewHeading({ review }: { review: DomainReviewReview }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
    // Show the Dialog title alongside the focused review heading on first open
    // and explicit re-review; ordinary GET notifications do not run this effect.
    heading.current?.closest<HTMLElement>(".dialog-content")?.scrollTo?.({ top: 0 });
  }, [review]);
  return (
    <h3 tabIndex={-1} ref={heading}>
      기록할 상태 검토
    </h3>
  );
}
function Review({ access, query, initialReview, assertSelected, onClose, returnFocusRef }: Props) {
  const source = initialReview.source;
  const [review, setReview] = useState(initialReview);
  const reviewRef = useRef(review);
  const consentRef = useRef<DomainReviewReview | undefined>(undefined);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string>();
  const resultRegion = useRef<HTMLDivElement>(null);
  const operation = useDomainReviewOperation({
    access,
    query,
    assertSelected,
    dirty: consent,
    onClose,
    isApproved: (candidate) => candidate === reviewRef.current && consentRef.current === candidate,
  });
  const current = query.isCurrent(review.snapshot) && review.approval === access.approval;
  const matching = query.result.data && currentDomainReview(source, query.result.data);
  const text = (value: string) => domainReviewText(value, access.prefixes);
  const reReview = () => {
    if (operation.pending || operation.acknowledged || operation.unconfirmed) return;
    try {
      assertSelected();
      access.assertApproval(access.approval);
      if (!matching) {
        setError(domainReviewUnconfirmed);
        return;
      }
      const snapshot = query.capture(matching);
      const candidate = Object.freeze({ source, snapshot, approval: access.approval });
      consentRef.current = undefined;
      reviewRef.current = candidate;
      setConsent(false);
      setError(undefined);
      setReview(candidate);
    } catch {
      setError(domainReviewChanged);
    }
  };
  useLayoutEffect(() => {
    if (operation.acknowledged) {
      resultRegion.current?.focus();
      resultRegion.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [operation.acknowledged]);
  const requestId = isAppError(operation.error) ? operation.error.requestId : undefined;
  return (
    <Dialog
      open
      title="도메인 검토 상태 기록"
      description="선택한 항목의 승인 또는 거절 상태 기록을 요청합니다."
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
            <>
              <Button
                aria-disabled={
                  operation.pending ||
                  operation.unconfirmed ||
                  !query.ready ||
                  !matching ||
                  !access.write.allowed
                }
                onClick={reReview}
              >
                기록할 상태 다시 검토
              </Button>
              <Button
                variant={source.action === "reject" ? "danger" : "primary"}
                aria-busy={operation.phase === "recording"}
                aria-disabled={
                  operation.pending ||
                  operation.unconfirmed ||
                  !operation.reviewCurrent(review) ||
                  !access.write.allowed
                }
                onClick={() => operation.save(review)}
              >
                {source.action === "approve" ? "승인 상태 기록" : "거절 상태 기록"}
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <div className="domain-review-dialog">
        <ReviewHeading review={review} />
        <p>
          이 작업은 선택한 검토 ID의 상태와 검토 시각만 기록합니다. 학습 예시로 승격하거나 라우팅 규칙을
          바꾸지 않습니다.
        </p>
        <p>
          서버는 현재 상태가 검토 대기인지, 다른 검토자가 먼저 변경했는지 확인하지 않습니다. 동시에 요청하면
          마지막으로 처리된 상태가 남을 수 있습니다. 조회 뒤에도 상태는 바뀔 수 있습니다.
        </p>
        <p>
          성공 응답만으로 항목의 존재나 실제 변경, 감사 기록과의 동시 저장을 확인할 수 없습니다. 기록 요청 후
          목록을 별도로 다시 조회합니다.
        </p>
        {!access.write.allowed ? (
          <InlineNotice tone="warning" title="현재 검토 상태를 기록할 수 없습니다.">
            {access.write.reason}
          </InlineNotice>
        ) : null}
        {!operation.acknowledged && !current ? (
          <InlineNotice tone="warning">
            {query.ready && !matching ? domainReviewUnconfirmed : domainReviewChanged}
          </InlineNotice>
        ) : null}
        {error ? <InlineNotice tone="warning">{error}</InlineNotice> : null}
        {query.result.isFetching ? (
          <p role="status">
            검토 목록을 조회하는 동안 원래 내용을 표시합니다. 새 동의와 기록은 잠시 사용할 수 없습니다.
          </p>
        ) : null}
        {query.result.isError ? (
          <InlineNotice tone="warning" title="최신 검토 목록을 확인하지 못했습니다.">
            원래 검토 내용을 표시합니다. 목록 조회를 다시 시도할 수 있습니다.
          </InlineNotice>
        ) : null}
        {operation.unconfirmed && operation.phase !== "recording" ? (
          <InlineNotice tone="warning" title="검토 상태 기록 여부를 확인하지 못했습니다.">
            응답이 불확실해 이 창에서는 다시 기록하지 않습니다. 목록을 다시 조회해도 이전 요청의 완료 여부는
            확정할 수 없습니다. 새 창에서 요청하면 이미 처리된 상태를 다시 덮어쓸 수 있습니다.
          </InlineNotice>
        ) : null}
        {operation.error ? (
          <InlineNotice
            tone="danger"
            title={
              operation.acknowledged
                ? "기록 응답은 확인했지만 목록을 다시 조회하지 못했습니다."
                : "검토 조회 또는 상태 기록 응답을 확인하지 못했습니다."
            }
          >
            현재 권한과 조회 상태를 확인하세요.
            {requestId ? <p>요청 ID: {text(requestId)}</p> : null}
          </InlineNotice>
        ) : null}
        {operation.acknowledged ? (
          <div role="region" aria-label="도메인 검토 상태 기록 결과" tabIndex={-1} ref={resultRegion}>
            <InlineNotice tone="success" title={domainReviewAcknowledged}>
              응답의 검토 ID와 요청한 상태가 일치합니다. 실제 변경과 이후 상태는 목록에서 따로 확인하세요.
            </InlineNotice>
          </div>
        ) : null}
        <section aria-label="원래 검토 내용">
          <h4>원래 검토 내용</h4>
          <p>조회 상태: {domainReviewStatusLabels[source.status]} · 최대 50건 응답에서 선택한 항목입니다.</p>
          <dl className="domain-review-values">
            {domainReviewFields.map(([field, label]) => (
              <div key={field}>
                <dt>{label}</dt>
                <dd>
                  {field === "status"
                    ? domainReviewStatusText(source.item.status, access.prefixes, true)
                    : text(source.item[field])}
                </dd>
              </div>
            ))}
            <div>
              <dt>요청할 상태</dt>
              <dd>{source.action === "approve" ? "승인 (approved)" : "거절 (rejected)"}</dd>
            </div>
          </dl>
          {!operation.acknowledged ? (
            <Checkbox
              label="이 작업은 검토 상태만 기록함을 확인했습니다"
              checked={consent && current}
              disabled={operation.pending || operation.unconfirmed || !current || !access.write.allowed}
              onChange={(event) => {
                if (operation.pending || operation.unconfirmed || !current || reviewRef.current !== review)
                  return;
                try {
                  assertSelected();
                  access.assertApproval(review.approval);
                  if (!query.isCurrent(review.snapshot)) return;
                } catch {
                  return;
                }
                consentRef.current = event.target.checked ? review : undefined;
                setConsent(event.target.checked);
              }}
            />
          ) : null}
        </section>
        {operation.pending ? (
          <p role="status">
            {operation.phase === "recording"
              ? "검토 상태 기록을 요청하고 있습니다."
              : "검토 목록을 다시 조회하고 있습니다."}
          </p>
        ) : null}
        {operation.refreshed ? (
          <p role="status">
            검토 목록 조회를 완료했습니다. 이 결과만으로 이전 기록 요청의 처리 여부를 확정할 수 없습니다.
          </p>
        ) : null}
        <div className="domain-review-actions">
          <Button
            aria-disabled={operation.pending || query.result.isFetching}
            aria-busy={operation.phase === "refreshing"}
            onClick={operation.refresh}
          >
            검토 목록 다시 조회
          </Button>
        </div>
        {operation.refreshFailed ? (
          <p>상태 기록을 반복하지 않고 목록 조회만 다시 시도할 수 있습니다.</p>
        ) : null}
      </div>
    </Dialog>
  );
}
export function DomainReviewDialog(props: Props) {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <Review {...props} />
  ) : (
    <UnsavedChangesProvider>
      <Review {...props} />
    </UnsavedChangesProvider>
  );
}
