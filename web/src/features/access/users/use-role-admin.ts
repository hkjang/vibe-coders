import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import type { SaveRoleBody } from "@/shared/api/domains/access";
import type { RoleRow } from "@/shared/api/domains/access.schemas";
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
const api = endpoints.domains.access.roles;
const pending = new WeakMap<QueryClient, Set<string>>();
// These are the role API's editable settings and its immutable builtin marker.
const snapshot = (role: RoleRow) =>
  JSON.stringify([
    role.role,
    role.is_system,
    role.description,
    role.default_home,
    [...new Set(role.scopes)].sort(),
  ]);

export function useRoleAdmin(owner: FeatureReadOwner, canWrite: boolean, reason: string) {
  const client = useQueryClient();
  const auth = useAuth();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const principal = JSON.stringify([epoch, auth.mode, auth.user?.id]);
  const write = useFeatureMutationAccess(
    [routeId],
    canWrite && (auth.mode !== "authenticated" || auth.user?.scopes.includes("admin:write") === true),
    reason,
  );
  const assertCurrent = () => {
    assertFeatureRead(owner);
    write.assertCurrent();
  };
  const ownsResult = () => {
    try {
      assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  const queryOptions = {
    queryKey: featureOwnedKey([...accessKeys.roles, "administration"], owner),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(api.administration, { signal, routeId });
      assertFeatureRead(owner, signal);
      if (
        [...data.all_scopes, ...data.roles.flatMap((row) => [row.role, ...row.scopes])].some((value) =>
          containsPotentialSecret(value, auth.credentialPrefixes),
        )
      )
        throw new AppError("역할 목록을 확인하지 못했습니다.", { kind: "contract" });
      return data;
    },
    gcTime: 0,
    staleTime: 0,
    retry: false as const,
  };
  const interval = useRefreshInterval();
  const roles = useQuery({
    ...queryOptions,
    enabled: owner.readable && !owner.denied,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const confirmed = roles.isSuccess && roles.fetchStatus === "idle";
  const run = async <T>(
    baseline: RoleRow | undefined,
    name: string,
    operation: (catalog: NonNullable<typeof roles.data>) => Promise<T>,
  ) => {
    assertCurrent();
    let entries = pending.get(client);
    if (!entries) {
      entries = new Set();
      pending.set(client, entries);
    }
    if (entries.has(principal))
      throw new AppError("역할 변경을 처리 중입니다. 완료 후 다시 확인하세요.", {
        kind: "aborted",
        code: "role_write_in_progress",
      });
    entries.add(principal);
    try {
      const state = client.getQueryState(queryOptions.queryKey);
      if (state?.status !== "success" || state.fetchStatus !== "idle" || state.isInvalidated)
        throw new AppError("최신 역할 목록을 확인한 뒤 다시 시도하세요.", {
          kind: "contract",
          code: "role_catalog_unconfirmed",
        });
      const fresh = await client.fetchQuery(queryOptions);
      assertCurrent();
      const matches = fresh.roles.filter((row) => row.role === name);
      const match = matches[0];
      if (
        baseline
          ? matches.length !== 1 ||
            !match ||
            baseline.role !== name ||
            match.is_system ||
            snapshot(match) !== snapshot(baseline)
          : matches.length !== 0
      )
        throw new AppError(
          baseline
            ? "역할이 변경되었거나 없어졌습니다. 편집창을 다시 열어 확인하세요."
            : "이미 등록된 역할 이름입니다. 목록의 수정 기능을 이용하세요.",
          { kind: "contract", code: baseline ? "role_changed" : "role_already_exists" },
        );
      return await operation(fresh);
    } finally {
      entries.delete(principal);
    }
  };
  const save = useMutationFeedback({
    mutate: ({
      body,
      baseline,
    }: {
      body: SaveRoleBody & { scopes: readonly string[] };
      baseline?: RoleRow;
    }) =>
      run(baseline, body.role, async (fresh) => {
        if (body.scopes.some((scope) => !fresh.all_scopes.includes(scope)))
          throw new AppError("목록에 없는 권한은 선택을 해제한 뒤 다시 확인하세요.", {
            kind: "contract",
            code: "role_scope_unavailable",
          });
        assertCurrent();
        return apiClient.request(api.save, { body, routeId, retryUnauthorized: false });
      }),
    ownsResult,
    invalidates: [accessKeys.roles],
    successMessage: "역할을 저장했습니다.",
  });
  const remove = useMutationFeedback({
    mutate: (baseline: RoleRow) =>
      run(baseline, baseline.role, async () => {
        assertCurrent();
        return apiClient.request(api.remove, {
          query: { role: baseline.role },
          routeId,
          retryUnauthorized: false,
        });
      }),
    ownsResult,
    invalidates: [accessKeys.roles],
    successMessage: "역할을 삭제했습니다.",
  });
  return { roles, save, remove, write, confirmed, assertCurrent };
}
