import { useLayoutEffect, useRef, useState } from "react";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError, isAppError } from "@/shared/api/error";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { assertFeatureRead, featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useLibraryOwner } from "./library-context";
import { libraryError, libraryRouteId, safeLibraryError } from "./library-model";

const flights = new WeakMap<QueryClient, Set<string>>();
export function useLibraryAccess() {
  const auth = useAuth();
  return useFeatureMutationAccess(
    [libraryRouteId],
    auth.user?.scopes.includes("admin:write") ?? false,
    "이 작업에는 admin:write 권한과 프롬프트 보관함 편집 허용 설정이 필요합니다.",
  );
}
function usePrincipal() {
  const auth = useAuth();
  return JSON.stringify([auth.mode, auth.user?.id, auth.user?.team_id]);
}
export function useLibraryBusy() {
  const principal = usePrincipal();
  return useIsMutating({ mutationKey: ["prompt-library-write", principal] }) > 0;
}
interface Options<V, R> {
  prepare?: (value: V) => Promise<void>;
  mutate: (value: V) => Promise<R>;
  validate?: (result: R, value: V) => void;
  invalidates: readonly QueryKey[] | ((value: V) => readonly QueryKey[]);
  successMessage?: string | ((result: R, value: V) => string);
  errorMessage: string;
  onSuccess?: (result: R, value: V, assertCurrent: () => void) => Promise<void> | void;
}
export function useLibraryMutation<V = void, R = unknown>(options: Options<V, R>) {
  const owner = useLibraryOwner();
  const auth = useAuth();
  const access = useLibraryAccess();
  const client = useQueryClient();
  const principal = usePrincipal();
  const mounted = useRef(false);
  const revision = useRef(0);
  const [uncertain, setUncertain] = useState(false);
  useLayoutEffect(() => {
    revision.current++;
  }, [access.allowed]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mutation = useMutation({
    mutationKey: ["prompt-library-write", principal],
    retry: false,
    gcTime: 0,
    mutationFn: async (value: V) => {
      const generation = revision.current;
      const assertCurrent = () => {
        assertFeatureRead(owner);
        access.assertCurrent();
        if (!mounted.current || revision.current !== generation)
          throw new AppError("화면 또는 작업 권한이 변경됐습니다.", { kind: "aborted" });
      };
      assertCurrent();
      if (uncertain) throw libraryError("unknown");
      let pending = flights.get(client);
      if (!pending) {
        pending = new Set();
        flights.set(client, pending);
      }
      if (pending.has(principal)) throw libraryError("busy");
      pending.add(principal);
      let sent = false,
        acknowledged = false;
      try {
        if (options.prepare) {
          const queryKey = featureOwnedKey(["prompts", "write-review"], owner);
          try {
            await client.fetchQuery({
              queryKey,
              retry: false,
              staleTime: 0,
              gcTime: 0,
              queryFn: async () => {
                try {
                  await options.prepare?.(value);
                  assertCurrent();
                  return null;
                } catch (error) {
                  throw safeLibraryError(error, auth.credentialPrefixes);
                }
              },
            });
          } finally {
            client.removeQueries({ queryKey, exact: true });
          }
        }
        assertCurrent();
        sent = true;
        const result = await options.mutate(value);
        acknowledged = true;
        options.validate?.(result, value);
        // A tab can remount while its write is pending. Refresh the still-current
        // read owner even if the initiating component no longer exists. Keep
        // component and write-access checks for callbacks and notifications.
        assertFeatureRead(owner);
        const keys =
          typeof options.invalidates === "function" ? options.invalidates(value) : options.invalidates;
        await Promise.all(
          keys.map((queryKey) =>
            client.invalidateQueries({
              predicate: (query) =>
                query.queryKey.at(-2) === owner.marker &&
                query.queryKey.at(-1) === owner.id &&
                queryKey.every((part, index) => query.queryKey[index] === part),
            }),
          ),
        );
        assertCurrent();
        await options.onSuccess?.(result, value, assertCurrent);
        assertCurrent();
        if (options.successMessage)
          toast.success(
            typeof options.successMessage === "function"
              ? options.successMessage(result, value)
              : options.successMessage,
          );
        // A response may echo template content. Keep it out of Mutation data.
        return;
      } catch (error) {
        const rejected =
          isAppError(error) && error.status !== undefined && error.status >= 400 && error.status < 500;
        if (sent && (!rejected || acknowledged) && mounted.current && owner.isCurrent()) setUncertain(true);
        const safe = safeLibraryError(error, auth.credentialPrefixes);
        if (mounted.current && owner.isCurrent())
          toast.error(safeAppErrorMessage(safe, options.errorMessage), {
            description: safe.requestId ? `요청 ID: ${safe.requestId}` : undefined,
            duration: Number.POSITIVE_INFINITY,
          });
        throw safe;
      } finally {
        pending.delete(principal);
      }
    },
  });
  return { ...mutation, uncertain };
}
