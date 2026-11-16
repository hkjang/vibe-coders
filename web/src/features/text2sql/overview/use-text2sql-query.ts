import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { containsPotentialSecret } from "@/shared/security/secrets";

/** Each query owns its read lifetime; one denied panel must not hide another. */
export function useText2SqlQuery<Data>({
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
  const owner = useFeatureReadOwner("text2sql.overview", "text2sql-query");
  const interval = useRefreshInterval();
  const readable = owner.readable && !owner.denied;
  const active = enabled && readable;
  const query = useQuery({
    queryKey: featureOwnedKey(key, owner),
    enabled: active,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: active && automatic ? interval : false,
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
  let error: Error | null = enabled ? query.error : null;
  if (enabled && !readable)
    error = new AppError("현재 계정의 조회 권한을 확인하세요.", { kind: "permission", status: 403 });
  else if (isAppError(error))
    error = new AppError(safeAppErrorMessage(error, "조회 결과를 확인하지 못했습니다."), {
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
    active: enabled,
    refetch,
    error,
    data: current ? query.data : undefined,
    dataUpdatedAt: current ? query.dataUpdatedAt : 0,
    isPending: active && query.isPending,
    isFetching: active && query.isFetching,
    isError: Boolean(error),
  };
}
