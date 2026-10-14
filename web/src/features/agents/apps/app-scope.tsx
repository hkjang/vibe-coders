/* eslint-disable react-refresh/only-export-components -- Route-local ownership context and hooks. */
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { ErrorState, PermissionDenied } from "@/shared/components/state/PageStates";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";

const AppScope = createContext<FeatureReadOwner | undefined>(undefined);
export const appsKey = ["agents", "apps"] as const;

export function AppScopeBoundary({ children }: { children: ReactNode }) {
  const owner = useFeatureReadOwner("agents.apps", "app-workspace");
  if (!owner.readable) return <PermissionDenied permission="admin:read" />;
  if (owner.denied)
    return (
      <ErrorState message="업무 앱 조회 권한을 다시 확인하세요." onRetry={owner.restart} showLegacy={false} />
    );
  return (
    <AppScope.Provider key={owner.id} value={owner}>
      {children}
    </AppScope.Provider>
  );
}

export function useAppScope() {
  const owner = useContext(AppScope);
  if (!owner) throw new Error("업무 앱 조회 경계가 필요합니다.");
  return owner;
}

export function useAppRead<T>({
  queryKey,
  queryFn,
  enabled = true,
  refetchInterval = false,
}: {
  queryKey: readonly unknown[];
  queryFn: (context: { signal: AbortSignal }) => Promise<T>;
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  const owner = useAppScope();
  return useQuery({
    queryKey: featureOwnedKey(queryKey, owner),
    gcTime: 0,
    retry: false,
    enabled: enabled && owner.readable && !owner.denied,
    refetchInterval,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await queryFn({ signal });
      assertFeatureRead(owner, signal);
      return result;
    },
  });
}

export function useAppOperationAccess() {
  const owner = useAppScope();
  const auth = useAuth();
  const access = useFeatureMutationAccess(
    ["agents.apps"],
    auth.user?.scopes.includes("admin:write") ?? false,
    "AI 업무 앱을 변경하려면 admin:write 권한이 필요합니다.",
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
    listKey: featureOwnedKey(appsKey, owner),
  };
}
