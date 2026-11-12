import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/app/auth/AuthProvider";
import { isAppError } from "@/shared/api/error";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { assertFeatureRead, featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { useMeOwner } from "./me-console-context";
import { meError, meRouteId, safeMeError, safeMeMessage } from "./me-console-model";
import type { MeRead } from "./me-console-api";

type Flight = "idle" | "pending" | "unknown";
const flights = new WeakMap<QueryClient, Map<string, Flight>>();
const listeners = new Set<() => void>();
const subscribe = (callback: () => void) => {
  listeners.add(callback);
  return () => listeners.delete(callback);
};
function setFlight(client: QueryClient, key: string, state: Flight) {
  let values = flights.get(client);
  if (!values) {
    values = new Map();
    flights.set(client, values);
  }
  if (state === "idle") values.delete(key);
  else values.set(key, state);
  listeners.forEach((callback) => callback());
}
export function useMeOperation<Input, Result>({
  operation,
  validate,
  run,
  accept,
  invalidates,
  message,
}: {
  operation: string;
  validate: (input: Input, prefixes: readonly string[]) => void;
  run: (input: Input, scope: MeRead) => Promise<Result>;
  accept: (result: Result, input: Input) => boolean;
  invalidates: readonly string[];
  message: string;
}) {
  const auth = useAuth(),
    owner = useMeOwner(),
    client = useQueryClient();
  const access = useFeatureMutationAccess([meRouteId], Boolean(auth.user?.id));
  const key = JSON.stringify([auth.mode, auth.user?.id, auth.user?.team_id, operation]);
  const flight = useSyncExternalStore(subscribe, () => flights.get(client)?.get(key) ?? "idle");
  const mounted = useRef(false),
    generation = useRef(0);
  useLayoutEffect(() => {
    generation.current++;
  }, [access.allowed]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mutation = useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: async (input: Input) => {
      const revision = generation.current;
      const assertCurrent = () => {
        assertFeatureRead(owner);
        access.assertCurrent();
        if (!mounted.current || generation.current !== revision) throw meError("changed");
      };
      assertCurrent();
      validate(input, auth.credentialPrefixes);
      const existing = flights.get(client)?.get(key);
      if (existing) throw meError(existing === "pending" ? "busy" : "unknown");
      setFlight(client, key, "pending");
      let sent = false,
        responded = false,
        confirmed = false,
        uncertain = false;
      try {
        assertCurrent();
        sent = true;
        const result = await run(input, {
          user: auth.user?.id ?? "",
          team: auth.user?.team_id ?? "",
          prefixes: auth.credentialPrefixes,
        });
        responded = true;
        if (!accept(result, input)) throw meError("unknown");
        confirmed = true;
        // A known successful write can refresh the current account after a tab
        // remount, but must never touch another account's query lifetime.
        assertFeatureRead(owner);
        await client.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === "me" &&
            invalidates.includes(String(query.queryKey[1])) &&
            query.queryKey.at(-2) === owner.marker &&
            query.queryKey.at(-1) === owner.id,
        });
        assertCurrent();
        toast.success(message);
        return result;
      } catch (error) {
        const rejected =
          isAppError(error) && error.status !== undefined && error.status >= 400 && error.status < 500;
        uncertain = sent && !confirmed && (!rejected || responded);
        const safe = safeMeError(error, auth.credentialPrefixes);
        if ((safe.status === 401 || safe.status === 403) && owner.isCurrent()) {
          const queryKey = featureOwnedKey(["me", "authorization"], owner);
          try {
            await client.fetchQuery({
              queryKey,
              retry: false,
              staleTime: 0,
              gcTime: 0,
              queryFn: async () => {
                throw safe;
              },
            });
          } catch {
            /* The read boundary handles the denial without replaying the write. */
          } finally {
            client.removeQueries({ queryKey, exact: true });
          }
        }
        if (mounted.current && owner.isCurrent())
          toast.error(safeMeMessage(safe), { duration: Number.POSITIVE_INFINITY });
        throw safe;
      } finally {
        setFlight(client, key, uncertain ? "unknown" : "idle");
      }
    },
  });
  const execute = (input: Input) => {
    // Validate before TanStack stores mutation variables, including free text.
    try {
      validate(input, auth.credentialPrefixes);
    } catch (error) {
      return Promise.reject(safeMeError(error, auth.credentialPrefixes));
    }
    return mutation.mutateAsync(input);
  };
  return {
    execute,
    access,
    pending: flight === "pending",
    uncertain: flight === "unknown",
    error: mutation.error,
    disabled: !access.allowed || flight !== "idle",
  };
}
