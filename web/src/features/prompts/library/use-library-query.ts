import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { assertFeatureRead, featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { useLibraryOwner } from "./library-context";
import { safeLibraryError } from "./library-model";

export function useLibraryQuery<T>({
  key,
  read,
  enabled = true,
}: {
  key: readonly unknown[];
  read: (prefixes: readonly string[], signal: AbortSignal) => Promise<T>;
  enabled?: boolean;
}) {
  const owner = useLibraryOwner();
  const { credentialPrefixes } = useAuth();
  return useQuery({
    queryKey: featureOwnedKey(key, owner),
    enabled,
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        assertFeatureRead(owner, signal);
        const result = await read(credentialPrefixes, signal);
        assertFeatureRead(owner, signal);
        return result;
      } catch (error) {
        throw safeLibraryError(error, credentialPrefixes);
      }
    },
  });
}
