/* eslint-disable react-refresh/only-export-components -- Route-local ownership context and hooks. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useId, useRef, type ReactNode } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { ErrorState, PermissionDenied } from "@/shared/components/state/PageStates";
import { skillMutationOwners } from "@/shared/feature-access/policy";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";

const SkillScope = createContext<FeatureReadOwner | undefined>(undefined);
export const skillsKey = ["agents", "skills"] as const;

export function SkillScopeBoundary({ children }: { children: ReactNode }) {
  const owner = useFeatureReadOwner("agents.skills", "skill-workspace");
  if (!owner.readable) return <PermissionDenied permission="admin:read" />;
  if (owner.denied)
    return (
      <ErrorState message="스킬 조회 권한을 다시 확인하세요." onRetry={owner.restart} showLegacy={false} />
    );
  return (
    <SkillScope.Provider key={owner.id} value={owner}>
      {children}
    </SkillScope.Provider>
  );
}
export function useSkillScope() {
  const owner = useContext(SkillScope);
  if (!owner) throw new Error("스킬 조회 경계가 필요합니다.");
  return owner;
}
export function useSkillRead<T>({
  queryKey,
  queryFn,
  enabled = true,
  refetchInterval = false,
  refetchOnMount,
}: {
  queryKey: readonly unknown[];
  queryFn: (context: { signal: AbortSignal }) => Promise<T>;
  enabled?: boolean;
  refetchInterval?: number | false;
  refetchOnMount?: boolean | "always";
}) {
  const owner = useSkillScope();
  return useQuery({
    queryKey: featureOwnedKey(queryKey, owner),
    gcTime: 0,
    retry: false,
    enabled: enabled && owner.readable && !owner.denied,
    refetchInterval,
    refetchOnMount,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await queryFn({ signal });
      assertFeatureRead(owner, signal);
      return result;
    },
  });
}

/** Explicit reads also participate in cancellation and the 401/403 boundary. */
export function useSkillReadAction() {
  const owner = useSkillScope();
  const client = useQueryClient();
  const sequence = useRef(0);
  const instance = useId();
  return async <T,>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    assertFeatureRead(owner);
    // A distinct serial prevents a prior result from satisfying a new button action.
    const queryKey = featureOwnedKey([...skillsKey, "action", instance, ++sequence.current], owner);
    const result = await client.fetchQuery({
      queryKey,
      gcTime: 0,
      staleTime: 0,
      retry: false,
      queryFn: async ({ signal }) => {
        assertFeatureRead(owner, signal);
        const data = await work(signal);
        assertFeatureRead(owner, signal);
        return data;
      },
    });
    assertFeatureRead(owner);
    return result;
  };
}

export function useSkillOperationAccess(authorized?: boolean, reason?: string) {
  const auth = useAuth();
  const owner = useSkillScope();
  const client = useQueryClient();
  const access = useFeatureMutationAccess(
    skillMutationOwners,
    authorized ?? auth.user?.scopes.includes("admin:write") ?? false,
    reason ?? "스킬을 변경하려면 admin:write 권한이 필요합니다.",
  );
  const assertCurrent = () => {
    assertFeatureRead(owner);
    access.assertCurrent();
  };
  return {
    ...access,
    assertCurrent,
    ownsResult: () => {
      try {
        assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
    refreshReads: async <T,>(result: T): Promise<T> => {
      assertCurrent();
      await client.invalidateQueries({
        queryKey: skillsKey,
        predicate: ({ queryKey }) => queryKey.at(-2) === owner.marker && queryKey.at(-1) === owner.id,
      });
      assertCurrent();
      return result;
    },
  };
}
