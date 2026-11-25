import { useQuery } from "@tanstack/react-query";
import { AppError, isAppError } from "@/shared/api/error";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";

export interface InsightQuery<Data> {
  data: Data | undefined;
  error: unknown;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: () => void;
}

/** A failed widget can be retried independently. Forbidden reads discard their old values. */
export function useInsightQuery<Data>({
  queryKey,
  queryFn,
  enabled = true,
}: {
  queryKey: readonly unknown[];
  queryFn: (context: { signal: AbortSignal }) => Promise<Data>;
  enabled?: boolean;
}): InsightQuery<Data> {
  const owner = useFeatureReadOwner("data.warehouse", "dw-insight");
  const allowed = owner.readable && !owner.denied;
  const interval = useRefreshInterval();
  const query = useQuery({
    queryKey: featureOwnedKey(queryKey, owner),
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await queryFn({ signal });
      assertFeatureRead(owner, signal);
      return data;
    },
    enabled: enabled && allowed,
    gcTime: 0,
    retry: false,
    refetchInterval: enabled && allowed ? interval : false,
    refetchIntervalInBackground: false,
  });
  const forbidden = !allowed || (isAppError(query.error) && [401, 403].includes(query.error.status ?? 0));
  const error = forbidden
    ? new AppError("현재 계정의 조회 권한을 확인하세요.", { kind: "permission", status: 403 })
    : query.error;
  return {
    data: allowed && enabled && !forbidden ? query.data : undefined,
    error,
    isPending: allowed && enabled && query.isPending,
    isError: Boolean(error),
    isFetching: allowed && enabled && query.isFetching,
    dataUpdatedAt: allowed && enabled && !forbidden ? query.dataUpdatedAt : 0,
    refetch: () => {
      if (!enabled) return;
      if (owner.denied) owner.restart();
      else if (owner.isCurrent()) void query.refetch();
    },
  };
}
