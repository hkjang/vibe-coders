import { useRoutingCreateAccess } from "./routing-rule-create-access";

// Reuse the existing create permission/identity contract without changing the
// manual-create flow. Query and selection lifetimes are local to learning.
export function useLearningRecommendationAccess(canWrite: boolean) {
  return useRoutingCreateAccess(canWrite);
}
export type LearningRecommendationAccess = ReturnType<typeof useLearningRecommendationAccess>;
