import { useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { assertFeatureRead, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";

const pending = new WeakMap<QueryClient, Set<string>>();
/** Independent operation groups retain their lock across local screen remounts. */
export function useAccessOperation(
  owner: FeatureReadOwner,
  canWrite: boolean,
  reason: string,
  group: "key-promotion" | "budget-notification" | "quota-budget",
  allowTeamAdmin = false,
) {
  const auth = useAuth();
  const client = useQueryClient();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const principal = JSON.stringify([group, epoch, auth.mode, auth.user?.id]);
  const write = useFeatureMutationAccess(
    ["access.users"],
    canWrite &&
      (auth.mode !== "authenticated" ||
        auth.user?.scopes.includes("admin:write") === true ||
        (allowTeamAdmin && auth.user?.role === "team_admin")),
    reason,
  );
  const assertCurrent = () => {
    assertFeatureRead(owner);
    write.assertCurrent();
  };
  const safety = {
    gcTime: 0,
    ownsResult: () => {
      try {
        assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
  };
  async function run<Result>(send: () => Promise<Result>): Promise<Result> {
    assertCurrent();
    let flights = pending.get(client);
    if (!flights) {
      flights = new Set();
      pending.set(client, flights);
    }
    if (flights.has(principal)) throw new AppError("현재 계정의 작업을 처리 중입니다.", { kind: "aborted" });
    flights.add(principal);
    try {
      return await send();
    } finally {
      flights.delete(principal);
    }
  }
  return { write, assertCurrent, safety, run };
}
