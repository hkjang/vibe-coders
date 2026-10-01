import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { formatDateTime, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";
import type { LearningRecommendationAccess } from "./learning-recommendation-access";
import {
  useLearningRecommendationOperation,
  type RecommendationReview,
} from "./learning-recommendation-operation";
import type { LearningRecommendationQuery } from "./learning-recommendation-query";
import {
  buildRecommendation,
  currentRecommendation,
  learningBucketLabel,
  learningText,
  learningWindowLabels,
  recommendationChanged,
  recommendationFields,
  recommendationReplaced,
  type RecommendationSource,
} from "./learning-recommendation-state";
import { createAcknowledgedMessage } from "./routing-rule-create-state";
import "./learning-recommendation.css";

interface Props {
  access: LearningRecommendationAccess;
  query: LearningRecommendationQuery;
  source: RecommendationSource;
  initialReview: RecommendationReview;
  assertSelected: () => void;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
function ReviewHeading({ review }: { review: RecommendationReview }) {
  const heading = useRef<HTMLHeadingElement>(null);
  // This child mounts with the delayed Dialog portal, after its heading exists.
  useLayoutEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView?.({ block: "start" });
  }, [review]);
  return (
    <h3 tabIndex={-1} ref={heading}>
      생성 내용 검토
    </h3>
  );
}
function Review({ access, query, source, initialReview, assertSelected, onClose, returnFocusRef }: Props) {
  const [review, setReview] = useState(initialReview);
  const reviewRef = useRef(review);
  const impactRef = useRef<RecommendationReview | undefined>(undefined);
  const [impact, setImpact] = useState(false);
  const [error, setError] = useState<string>();
  const result = useRef<HTMLDivElement>(null);
  const operation = useLearningRecommendationOperation({
    access,
    query,
    assertSelected,
    dirty: impact,
    onClose,
    isApproved: (candidate): candidate is RecommendationReview =>
      candidate === reviewRef.current && impactRef.current === candidate,
  });
  const current = query.isCurrent(review.snapshot) && review.approval === access.approval;
  const matching = query.result.data && currentRecommendation(source, query.result.data);
  const reReview = () => {
    if (operation.pending || operation.acknowledged || operation.unconfirmed) return;
    try {
      assertSelected();
      access.assertApproval(access.approval);
      if (!matching) {
        setError(recommendationReplaced);
        return;
      }
      const snapshot = query.capture(matching);
      const candidate = Object.freeze({
        snapshot,
        body: buildRecommendation(matching, access.prefixes),
        approval: access.approval,
      });
      impactRef.current = undefined;
      reviewRef.current = candidate;
      setImpact(false);
      setError(undefined);
      setReview(candidate);
    } catch {
      setError(recommendationChanged);
    }
  };
  const refreshRecommendation = () => {
    if (operation.pending) return;
    try {
      assertSelected();
      query.refresh();
    } catch {
      /* Retired selection. */
    }
  };
  useLayoutEffect(() => {
    if (operation.acknowledged) {
      result.current?.focus();
      result.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [operation.acknowledged]);
  const text = (value: string | number, empty?: string) => learningText(value, access.prefixes, empty);
  const original = source.recommendation;
  const requestId = isAppError(operation.error) ? operation.error.requestId : undefined;
  return (
    <Dialog
      open
      title="학습 추천으로 규칙 만들기"
      description="관측된 추천과 실제 생성 범위를 검토한 뒤 사용 중인 규칙의 생성을 요청합니다."
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
                생성 내용 다시 검토
              </Button>
              <Button
                variant="primary"
                aria-busy={operation.phase === "creating"}
                aria-disabled={
                  operation.pending ||
                  operation.unconfirmed ||
                  !operation.reviewCurrent(review) ||
                  !access.write.allowed
                }
                onClick={() => operation.save(review)}
              >
                규칙 만들기
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <div className="learning-recommendation-dialog">
        <ReviewHeading review={review} />
        <p>
          작업 유형은 관측 표본을 나눈 기준일 뿐, 만들어지는 규칙의 적용 조건이 아닙니다. 모델 패턴은 모든
          모델(*)이며 해당 복잡도 범위에 적용될 수 있습니다.
        </p>
        <p>
          새 규칙은 사용 중으로 생성됩니다. 실제 선택은 라우팅 활성 여부·모델 패턴·복잡도·우선순위에 따르며
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
        {!operation.acknowledged && !current ? (
          <InlineNotice tone="warning">
            {query.ready && !matching ? recommendationReplaced : recommendationChanged}
          </InlineNotice>
        ) : null}
        {error ? <InlineNotice tone="warning">{error}</InlineNotice> : null}
        {query.result.isError ? (
          <InlineNotice tone="warning" title="최신 추천을 확인하지 못했습니다.">
            이전 검토 내용을 표시하고 있습니다. 추천을 다시 조회한 뒤 새로 검토하세요.
          </InlineNotice>
        ) : null}
        {query.result.isFetching ? (
          <p role="status">
            추천을 확인하는 동안 기존 검토 내용을 표시합니다. 새 동의와 생성은 잠시 사용할 수 없습니다.
          </p>
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
            {safeAppErrorMessage(operation.error, "현재 권한과 검토 기준을 확인한 뒤 다시 조회하세요.")}
            {requestId ? <p>요청 ID: {text(requestId)}</p> : null}
          </InlineNotice>
        ) : null}
        {operation.acknowledged ? (
          <div role="region" aria-label="라우팅 규칙 생성 결과" tabIndex={-1} ref={result}>
            <InlineNotice tone="success" title={createAcknowledgedMessage}>
              서버의 생성 응답을 확인했습니다. 실제 라우팅 적용과 이후 상태는 별도로 확인하세요.
            </InlineNotice>
          </div>
        ) : null}
        <section aria-label="검토 기준 추천">
          <h4>검토 기준 추천</h4>
          <dl className="learning-recommendation-values">
            <div>
              <dt>요청한 조회 기간</dt>
              <dd>{learningWindowLabels[source.window]}</dd>
            </div>
            <div>
              <dt>서버 응답의 집계 시작 시각</dt>
              <dd>{text(formatDateTime(source.since))}</dd>
            </div>
            <div>
              <dt>서버 응답의 집계 시작 시각 값</dt>
              <dd>{text(source.since)}</dd>
            </div>
            <div>
              <dt>최소 비교 표본</dt>
              <dd>{formatNumber(source.minSamples)}건</dd>
            </div>
            <div>
              <dt>관측 작업 유형</dt>
              <dd>{text(original.task_type)}</dd>
            </div>
            <div>
              <dt>관측 복잡도 구간</dt>
              <dd>{learningBucketLabel(original.bucket, access.prefixes)}</dd>
            </div>
            <div>
              <dt>원래 추천 모델 값</dt>
              <dd>{text(original.recommended_model)}</dd>
            </div>
            <div>
              <dt>관측 최다 모델</dt>
              <dd>{text(original.top_model)}</dd>
            </div>
            <div>
              <dt>추천 모델 표본</dt>
              <dd>{formatNumber(original.samples)}건</dd>
            </div>
            <div>
              <dt>추천 모델 성공률</dt>
              <dd>{formatPercent(original.success_rate)}</dd>
            </div>
            <div>
              <dt>관측 최다 모델 성공률</dt>
              <dd>{formatPercent(original.top_success_rate)}</dd>
            </div>
            <div>
              <dt>추천 모델 평균 비용</dt>
              <dd>{formatKRW(original.avg_cost_krw)}</dd>
            </div>
            <div>
              <dt>비교 표본 상태</dt>
              <dd>
                {original.confident ? "비교 모델 모두 최소 표본 충족" : "일부 비교 모델은 최소 표본 미달"}
              </dd>
            </div>
            <div>
              <dt>추천 설명</dt>
              <dd>{text(original.rationale)}</dd>
            </div>
          </dl>
          <p>
            요청한 기간과 서버가 반환한 시작 시각을 따로 표시합니다. 정확히 같은 시각 범위를 다시 조회했다는
            보장은 아닙니다.
          </p>
        </section>
        <section aria-label="새 규칙 생성 내용">
          <h4>실제 생성 요청값</h4>
          <dl className="learning-recommendation-values">
            <div>
              <dt>사용 상태</dt>
              <dd>사용 중으로 생성</dd>
            </div>
            {recommendationFields.map(([field, label]) => (
              <div key={field}>
                <dt>{label}</dt>
                <dd>{text(review.body[field], field === "target_provider" ? "자동 선택" : "없음")}</dd>
              </div>
            ))}
          </dl>
          {!operation.acknowledged ? (
            <Checkbox
              label="작업 유형과 관계없이 해당 복잡도 범위에 적용됨을 확인했습니다"
              checked={impact && current}
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
                impactRef.current = event.target.checked ? review : undefined;
                setImpact(event.target.checked);
              }}
            />
          ) : null}
        </section>
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
        <div className="learning-recommendation-actions">
          <Button
            aria-disabled={operation.pending || query.result.isFetching || !access.readable}
            aria-busy={query.result.isFetching}
            onClick={refreshRecommendation}
          >
            추천 다시 조회
          </Button>
          <Button
            aria-disabled={operation.pending || !access.readable}
            aria-busy={operation.phase === "refreshing"}
            onClick={operation.refresh}
          >
            목록 다시 조회
          </Button>
        </div>
        <div role="region" aria-label="학습 추천 검토 읽기 안내" tabIndex={0}>
          방향키와 Page Up·Page Down 키로 긴 검토 내용을 읽을 수 있습니다. 표시 보호는 서버 저장·감사 기록의
          비밀정보 제거를 뜻하지 않습니다.
        </div>
      </div>
    </Dialog>
  );
}
export function LearningRecommendationDialog(props: Props) {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <Review {...props} />
  ) : (
    <UnsavedChangesProvider>
      <Review {...props} />
    </UnsavedChangesProvider>
  );
}
