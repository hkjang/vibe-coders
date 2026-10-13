import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import type { UserSummary } from "@/shared/api/domains/access.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { assertFeatureRead, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { accessKeys } from "./use-access-admin";

const pending = new WeakMap<QueryClient, Set<string>>();
export function useExternalKeyPromotion(owner: FeatureReadOwner, canWrite: boolean, reason: string) {
  const auth = useAuth();
  const client = useQueryClient();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const principal = JSON.stringify([epoch, auth.mode, auth.user?.id]);
  const write = useFeatureMutationAccess(
    ["access.users"],
    canWrite &&
      (auth.mode !== "authenticated" ||
        auth.user?.scopes.includes("admin:write") === true ||
        auth.user?.role === "team_admin"),
    reason,
  );
  const assertCurrent = () => {
    assertFeatureRead(owner);
    write.assertCurrent();
  };
  const promoteKey = useMutationFeedback({
    gcTime: 0,
    ownsResult: () => {
      try {
        assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
    mutate: async (row: UserSummary) => {
      assertCurrent();
      let flights = pending.get(client);
      if (!flights) {
        flights = new Set();
        pending.set(client, flights);
      }
      if (flights.has(principal)) throw new AppError("관리 키 등록을 처리 중입니다.", { kind: "aborted" });
      flights.add(principal);
      try {
        return await apiClient.request(
          withPathParams(endpoints.domains.access.apiKeys.update, { id: row.api_key_id }),
          {
            body: { status: "active", name: row.name || row.api_key_id, team: row.team },
            routeId: "access.users",
            retryUnauthorized: false,
          },
        );
      } finally {
        flights.delete(principal);
      }
    },
    invalidates: [accessKeys.users, accessKeys.apiKeys],
    successMessage: "외부 키를 관리 키로 등록했습니다.",
  });
  return { promoteKey, write, assertCurrent };
}
