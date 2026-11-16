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
import { OverviewRefreshContext } from "./overview-refresh-context";

export interface OverviewQuery<Data> {
  data: Data | undefined;
  error: unknown;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: () => void;
}

/** Each widget owns its read lifetime; a denied widget does not stop its neighbours. */
export function useOverviewQuery<Data>({
  key,
  read,
  scope = "admin:read",
  interval = false,
  staleTime = 0,
}: {
  key: readonly unknown[];
  read: (signal: AbortSignal) => Promise<Data>;
  scope?: string;
  interval?: number | false;
  staleTime?: number;
}): OverviewQuery<Data> {
  const auth = useAuth();
  const refreshers = useContext(OverviewRefreshContext);
  const owner = useFeatureReadOwner("overview", "overview-widget", [], scope);
  const enabled = owner.readable && !owner.denied;
  const query = useQuery({
    queryKey: featureOwnedKey(["overview", ...key], owner),
    enabled,
    gcTime: 0,
    staleTime,
    retry: false,
    refetchInterval: enabled ? interval : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await read(signal);
      assertFeatureRead(owner, signal);
      return data;
    },
  });
  const { refetch: queryRefetch } = query;
  const refetch = useCallback(() => {
    if (owner.denied) owner.restart();
    else if (owner.isCurrent()) void queryRefetch();
  }, [owner, queryRefetch]);
  useLayoutEffect(() => {
    refreshers?.add(refetch);
    return () => {
      refreshers?.delete(refetch);
    };
  }, [refreshers, refetch]);
  let error: unknown = query.error;
  if (!enabled) {
    error = new AppError("현재 계정의 조회 권한을 확인하세요.", { kind: "permission", status: 403 });
  } else if (isAppError(error)) {
    const requestId = error.requestId;
    error = new AppError(safeAppErrorMessage(error, "운영 데이터를 확인하지 못했습니다."), {
      kind: error.kind,
      status: error.status,
      requestId:
        requestId && requestId.length <= 200 && !containsPotentialSecret(requestId, auth.credentialPrefixes)
          ? requestId
          : undefined,
    });
  }
  const current = enabled && owner.isCurrent();
  return {
    data: current ? query.data : undefined,
    error,
    isPending: enabled && query.isPending,
    isError: Boolean(error),
    isFetching: current && query.isFetching,
    dataUpdatedAt: current ? query.dataUpdatedAt : 0,
    refetch,
  };
}
