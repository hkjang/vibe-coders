import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import type { AuthTeamRow } from "@/shared/api/domains/access.schemas";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { accessKeys } from "./use-access-admin";

const routeId = "access.users";
const api = endpoints.domains.access.teams;
const pending = new WeakMap<QueryClient, Set<string>>();
const snapshot = (row: AuthTeamRow) => JSON.stringify([row.id, row.name, row.created_at, row.updated_at]);
export function useTeamAdmin(owner: FeatureReadOwner, canWrite: boolean, reason: string) {
  const auth = useAuth();
  const client = useQueryClient();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const principal = JSON.stringify([epoch, auth.mode, auth.user?.id]);
  const teamAdmin = auth.mode === "authenticated" && auth.user?.role === "team_admin";
  const write = useFeatureMutationAccess(
    [routeId],
    canWrite &&
      (auth.mode !== "authenticated" || auth.user?.scopes.includes("admin:write") === true || teamAdmin),
    reason,
  );
  const assertCurrent = () => {
    assertFeatureRead(owner);
    write.assertCurrent();
  };
  const options = {
    queryKey: featureOwnedKey([...accessKeys.teams, "administration"], owner),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(api.administration, { signal, routeId });
      assertFeatureRead(owner, signal);
      if (data.auth_teams.some((row) => containsPotentialSecret(row.id, auth.credentialPrefixes)))
        throw new AppError("팀 목록을 확인하지 못했습니다.", { kind: "contract" });
      return data;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false as const,
  };
  const interval = useRefreshInterval();
  const teams = useQuery({
    ...options,
    enabled: owner.readable && !owner.denied,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const canEdit = useCallback(
    (row: AuthTeamRow) => write.allowed && (!teamAdmin || row.id === auth.user?.team_id),
    [write.allowed, teamAdmin, auth.user?.team_id],
  );
  const save = useMutationFeedback({
    gcTime: 0,
    ownsResult: () => {
      try {
        assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
    mutate: async ({ body, baseline }: { body: { id: string; name: string }; baseline?: AuthTeamRow }) => {
      assertCurrent();
      if (teamAdmin && (!baseline || body.id !== auth.user?.team_id))
        throw new AppError("팀 관리자는 소속 팀의 이름만 수정할 수 있습니다.", {
          kind: "permission",
          code: "team_scope_denied",
        });
      if (
        !body.id.trim() ||
        body.id !== body.id.trim() ||
        [...body.id].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
        !body.name.trim() ||
        containsPotentialSecret(body.id, auth.credentialPrefixes)
      )
        throw new AppError("팀 ID와 이름을 다시 확인하세요.", {
          kind: "contract",
          code: "team_invalid_draft",
        });
      let flights = pending.get(client);
      if (!flights) {
        flights = new Set();
        pending.set(client, flights);
      }
      if (flights.has(principal))
        throw new AppError("팀 변경을 처리 중입니다.", { kind: "aborted", code: "team_write_in_progress" });
      flights.add(principal);
      try {
        const state = client.getQueryState(options.queryKey);
        if (state?.status !== "success" || state.fetchStatus !== "idle" || state.isInvalidated)
          throw new AppError("최신 팀 목록을 확인하세요.", {
            kind: "contract",
            code: "team_catalog_unconfirmed",
          });
        const fresh = await client.fetchQuery(options);
        assertCurrent();
        const matches = fresh.auth_teams.filter((row) => row.id === body.id);
        const match = matches[0];
        if (
          baseline
            ? !match ||
              matches.length !== 1 ||
              baseline.id !== body.id ||
              snapshot(match) !== snapshot(baseline)
            : matches.length !== 0
        )
          throw new AppError("팀 목록이 변경되었습니다.", {
            kind: "contract",
            code: baseline ? "team_changed" : "team_already_exists",
          });
        return await apiClient.request(api.create, {
          body: { id: body.id, name: body.name.trim() },
          routeId,
          retryUnauthorized: false,
        });
      } finally {
        flights.delete(principal);
      }
    },
    invalidates: [accessKeys.teams, accessKeys.users],
    successMessage: "팀을 저장했습니다.",
  });
  return {
    teams,
    save,
    write,
    assertCurrent,
    canEdit,
    canCreate: write.allowed && !teamAdmin,
    confirmed: teams.isSuccess && teams.fetchStatus === "idle",
  };
}
