import { useAccessOperation } from "./use-access-operation";
import { apiClient } from "@/shared/api/client";
import type { UserSummary } from "@/shared/api/domains/access.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { accessKeys } from "./use-access-admin";

export function useExternalKeyPromotion(owner: FeatureReadOwner, canWrite: boolean, reason: string) {
  const { write, assertCurrent, safety, run } = useAccessOperation(
    owner,
    canWrite,
    reason,
    "key-promotion",
    true,
  );
  const promoteKey = useMutationFeedback({
    ...safety,
    mutate: (row: UserSummary) =>
      run(() =>
        apiClient.request(withPathParams(endpoints.domains.access.apiKeys.update, { id: row.api_key_id }), {
          body: { status: "active", name: row.name || row.api_key_id, team: row.team },
          routeId: "access.users",
          retryUnauthorized: false,
        }),
      ),
    invalidates: [accessKeys.users, accessKeys.apiKeys],
    successMessage: "외부 키를 관리 키로 등록했습니다.",
  });
  return { promoteKey, write, assertCurrent };
}
