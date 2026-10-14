import { useQuery } from "@tanstack/react-query";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";

export function useFinopsReadQuery<T>(
  owner: FeatureReadOwner,
  key: readonly unknown[],
  read: (signal: AbortSignal) => Promise<T>,
  refetchInterval: number | false = false,
  enabled = true,
) {
  return useQuery({
    queryKey: featureOwnedKey(key, owner),
    gcTime: 0,
    retry: false,
    refetchInterval,
    enabled,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const value = await read(signal);
      assertFeatureRead(owner, signal);
      return value;
    },
  });
}
