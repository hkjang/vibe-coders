import { useQuery } from "@tanstack/react-query";
import { useCallback, useContext, useLayoutEffect } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { usePreferences } from "@/shared/stores/preferences";
import { refreshIntervalMs } from "@/features/health/health-utils";
import { SystemRefreshContext } from "./system-refresh-context";

export const systemQueryMarker = "system-health-query";
export function useSystemHealthQuery<Data>({
  key,
  read,
  enabled = true,
  automatic = true,
}: {
  key: readonly unknown[];
  read: (signal: AbortSignal) => Promise<Data>;
  enabled?: boolean;
  automatic?: boolean;
}) {
  const auth = useAuth();
  const refreshers = useContext(SystemRefreshContext);
  const owner = useFeatureReadOwner("system.health", systemQueryMarker);
  const interval = usePreferences((s) => s.refreshInterval);
  const readable = owner.readable && !owner.denied;
  const active = enabled && readable;
  const query = useQuery({
    queryKey: featureOwnedKey(key, owner),
    enabled: active,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: active && automatic ? refreshIntervalMs(interval) : false,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await read(signal);
      assertFeatureRead(owner, signal);
      return data;
    },
  });
  const { refetch: reload } = query;
  const refetch = useCallback(() => {
    if (!enabled) return;
    if (owner.denied) owner.restart();
    else if (owner.isCurrent()) void reload();
  }, [enabled, owner, reload]);
  useLayoutEffect(() => {
    if (!automatic || !enabled) return;
    refreshers?.add(refetch);
    return () => {
      refreshers?.delete(refetch);
    };
  }, [automatic, enabled, refreshers, refetch]);
  let error: Error | null = query.error;
  if (!readable)
    error = new AppError("현재 계정의 조회 권한을 확인하세요.", { kind: "permission", status: 403 });
  else if (isAppError(error))
    error = new AppError(safeAppErrorMessage(error, "운영 데이터를 확인하지 못했습니다."), {
      kind: error.kind,
      status: error.status,
      requestId:
        error.requestId &&
        error.requestId.length <= 200 &&
        !containsPotentialSecret(error.requestId, auth.credentialPrefixes)
          ? error.requestId
          : undefined,
    });
  const current = active && owner.isCurrent();
  return {
    ...query,
    owner,
    refetch,
    error,
    data: current ? query.data : undefined,
    dataUpdatedAt: current ? query.dataUpdatedAt : 0,
    isPending: active && query.isPending,
    isFetching: active && query.isFetching,
    isError: Boolean(error),
  };
}
