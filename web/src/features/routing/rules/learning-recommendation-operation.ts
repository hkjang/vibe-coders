import type { LearningRecommendationAccess } from "./learning-recommendation-access";
import type { LearningRecommendationQuery, RecommendationSnapshot } from "./learning-recommendation-query";
import { useRoutingCreateOperation, type CreateReview } from "./routing-rule-create-operation";

export interface RecommendationReview extends CreateReview {
  snapshot: RecommendationSnapshot;
}
export function useLearningRecommendationOperation({
  access,
  query,
  assertSelected,
  isApproved,
  dirty,
  onClose,
}: {
  access: LearningRecommendationAccess;
  query: LearningRecommendationQuery;
  assertSelected: () => void;
  isApproved: (candidate: CreateReview) => candidate is RecommendationReview;
  dirty: boolean;
  onClose: () => void;
}) {
  return useRoutingCreateOperation({
    access: {
      ...access,
      assertRead: () => {
        access.assertRead();
        query.assertRead();
        assertSelected();
      },
      assertApproval: (expected) => {
        assertSelected();
        access.assertApproval(expected);
      },
    },
    dirty,
    onClose,
    // Fresh report approval is required before dispatch, not after a valid ACK.
    // The existing create operation owns strict ACK/read-only follow-up and its
    // irreversible same-window sent-unconfirmed latch; no new retry is added.
    isReview: (candidate) => isApproved(candidate) && query.isCurrent(candidate.snapshot),
  });
}
