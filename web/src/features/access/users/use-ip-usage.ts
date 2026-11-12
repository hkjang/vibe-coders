import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { readIpList, readIpDetail } from "./ip-usage-api";
import { safeIpError } from "./ip-usage-model";
function useIpQuery<T>(
  owner: FeatureReadOwner,
  key: readonly unknown[],
  read: (scope: { signal: AbortSignal; prefixes: readonly string[] }) => Promise<T>,
  enabled = true,
) {
  const { credentialPrefixes } = useAuth();
  const interval = useRefreshInterval();
  return useQuery({
    queryKey: featureOwnedKey(["access", "ips", ...key], owner),
    enabled: enabled && owner.readable && !owner.denied,
    retry: false,
    gcTime: 0,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      try {
        assertFeatureRead(owner, signal);
        const result = await read({ signal, prefixes: credentialPrefixes });
        assertFeatureRead(owner, signal);
        return result;
      } catch (error) {
        throw safeIpError(error, credentialPrefixes);
      }
    },
  });
}
export const useIpList = (owner: FeatureReadOwner) => useIpQuery(owner, [], readIpList);
export const useIpDetail = (owner: FeatureReadOwner, ip: string) =>
  useIpQuery(owner, ["detail", ip], (scope) => readIpDetail(scope, ip), Boolean(ip));
