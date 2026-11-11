import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { teamReportDecisionSchema, type TeamReportRow } from "@/shared/api/domains/team.schemas";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { assertFeatureRead, featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { useTeamScope } from "./team-context";
import { readTeamReports } from "./team-api";
import { safeTeamError, safeTeamMessage, teamError, teamRouteId, validTeamText } from "./team-model";

type Flight = "idle" | "pending" | "unknown";
const flights = new WeakMap<QueryClient, Map<string, Flight>>();
const listeners = new Set<() => void>();
const subscribe = (callback: () => void) => {
  listeners.add(callback);
  return () => listeners.delete(callback);
};
function setFlight(client: QueryClient, key: string, value: Flight) {
  let states = flights.get(client);
  if (!states) {
    states = new Map();
    flights.set(client, states);
  }
  if (value === "idle") states.delete(key);
  else states.set(key, value);
  listeners.forEach((callback) => callback());
}
export function useTeamReportDecision() {
  const scope = useTeamScope(),
    auth = useAuth(),
    client = useQueryClient();
  const access = useFeatureMutationAccess([teamRouteId], auth.user?.scopes.includes("team:read") ?? true);
  const principal = JSON.stringify([auth.mode, auth.user?.id, auth.user?.team_id, scope.team]);
  const flight = useSyncExternalStore(subscribe, () => flights.get(client)?.get(principal) ?? "idle");
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
    mutationFn: async ({
      report,
      action,
      reason,
    }: {
      report: TeamReportRow;
      action: "approve" | "reject";
      reason: string;
    }) => {
      const revision = generation.current;
      const assertCurrent = () => {
        assertFeatureRead(scope.owner);
        access.assertCurrent();
        if (!mounted.current || generation.current !== revision) throw teamError("changed");
      };
      assertCurrent();
      if (!validTeamText(reason, auth.credentialPrefixes, 500)) throw teamError("invalid");
      if (
        report.team !== scope.team ||
        report.approval_status !== "pending" ||
        !/^[a-f0-9]{64}$/u.test(report.revision)
      )
        throw teamError("changed");
      const existing = flights.get(client)?.get(principal);
      if (existing) throw teamError(existing === "pending" ? "busy" : "unknown");
      setFlight(client, principal, "pending");
      let sent = false,
        acknowledged = false,
        confirmed = false,
        uncertain = false;
      try {
        const queryKey = featureOwnedKey(["team", "report-review", scope.team], scope.owner);
        try {
          await client.fetchQuery({
            queryKey,
            staleTime: 0,
            gcTime: 0,
            retry: false,
            queryFn: async ({ signal }) => {
              try {
                const latest = await readTeamReports({ ...scope, prefixes: auth.credentialPrefixes, signal });
                assertCurrent();
                const current = latest.reports.find((row) => row.id === report.id);
                if (
                  !current ||
                  current.revision !== report.revision ||
                  current.approval_status !== "pending" ||
                  JSON.stringify(current) !== JSON.stringify(report)
                )
                  throw teamError("changed");
                return null;
              } catch (error) {
                throw safeTeamError(error, auth.credentialPrefixes);
              }
            },
          });
        } finally {
          client.removeQueries({ queryKey, exact: true });
        }
        assertCurrent();
        sent = true;
        const result = await apiClient.request(endpoints.domains.access.team.decideReport, {
          body: { report_id: report.id, action, reason },
          query: scope.queryTeam ? { team: scope.queryTeam } : {},
          routeId: teamRouteId,
          retryUnauthorized: false,
          cache: "no-store",
        });
        acknowledged = true;
        const answer = teamReportDecisionSchema.parse(result);
        if (
          answer.report_id !== report.id ||
          answer.approval_status !== (action === "approve" ? "approved" : "rejected")
        )
          throw teamError("unknown");
        confirmed = true;
        // Refresh the current read lifetime even if its report tab remounted.
        assertFeatureRead(scope.owner);
        await client.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === "team" &&
            query.queryKey[1] === "reports" &&
            query.queryKey.at(-2) === scope.owner.marker &&
            query.queryKey.at(-1) === scope.owner.id,
        });
        assertCurrent();
        toast.success(action === "approve" ? "리포트를 승인했습니다." : "리포트를 반려했습니다.");
      } catch (error) {
        const rejected =
          isAppError(error) && error.status !== undefined && error.status >= 400 && error.status < 500;
        uncertain = sent && !confirmed && (!rejected || acknowledged);
        const safe = safeTeamError(error, auth.credentialPrefixes);
        // This endpoint uses team:read for both reads and decisions. A denial
        // must retire the current read lifetime without replaying the write.
        if ((safe.status === 401 || safe.status === 403) && scope.owner.isCurrent()) {
          const queryKey = featureOwnedKey(["team", "report-authorization", scope.team], scope.owner);
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
            /* The read-owner subscriber handles this authorization failure. */
          } finally {
            client.removeQueries({ queryKey, exact: true });
          }
        }
        if (mounted.current && scope.owner.isCurrent())
          toast.error(safeTeamMessage(safe, "리포트 작업을 완료하지 못했습니다."), {
            duration: Number.POSITIVE_INFINITY,
          });
        throw safe;
      } finally {
        setFlight(client, principal, uncertain ? "unknown" : "idle");
      }
    },
  });
  return { ...mutation, access, busy: flight === "pending", uncertain: flight === "unknown" };
}
