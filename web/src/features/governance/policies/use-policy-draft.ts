import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import type { PolicySuggestion } from "@/shared/api/domains/governance";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import type { PolicyDraftAccess } from "./policy-draft-access";
import type { SimulationWindow } from "./policy-simulation-state";
import {
  draftSourceReason,
  draftStopped,
  policyDraftAcknowledged,
  policyDraftSnapshot,
  type PolicyDraftSnapshot,
} from "./policy-draft-state";

type Outcome =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success"; refreshFailed: boolean }
  | { kind: "error"; message: string; requestId?: string; uncertain: boolean };
interface Selection {
  snapshot: PolicyDraftSnapshot;
  trigger: HTMLButtonElement;
}
interface Approval {
  selection: Selection;
  data: unknown;
  window: SimulationWindow;
  updated: number;
}
export function usePolicyDraft(access: PolicyDraftAccess, window: SimulationWindow) {
  const client = useQueryClient();
  const key = ["governance", "advisor", window];
  const source = useSyncExternalStore(
    useCallback((notify) => client.getQueryCache().subscribe(notify), [client]),
    () => client.getQueryState(key),
  );
  const [refreshResult, setRefreshResult] = useState<{
    window: SimulationWindow;
    status: "idle" | "pending" | "error";
  }>({ window, status: "idle" });
  const refreshState = refreshResult.window === window ? refreshResult.status : "idle";
  const confirmed =
    refreshState === "idle" &&
    source?.status === "success" &&
    source.fetchStatus === "idle" &&
    !source.isInvalidated;
  const [selection, setSelection] = useState<Selection>();
  const [review, setReview] = useState<Approval>();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const selected = useRef<Selection | undefined>(undefined);
  const approval = useRef<Approval | undefined>(undefined);
  const flight = useRef<AbortController | undefined>(undefined);
  const committed = useRef<Selection | undefined>(undefined);
  const followup = useRef<AbortController | undefined>(undefined);
  const refreshFlight = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);
  const latest = useRef({ window, confirmed });
  useLayoutEffect(
    () => () => {
      refreshFlight.current?.abort();
      refreshFlight.current = undefined;
      // Discard this canceled period's pending marker before a later A → B → A return.
      setRefreshResult((previous) =>
        previous.window === window && previous.status === "pending" ? { window, status: "idle" } : previous,
      );
    },
    [window],
  );
  useLayoutEffect(() => {
    latest.current = { window, confirmed };
    if (
      !access.write.allowed ||
      !confirmed ||
      approval.current?.data !== source?.data ||
      approval.current?.window !== window ||
      approval.current?.updated !== source?.dataUpdatedAt
    ) {
      approval.current = undefined;
      setReview(undefined);
    }
  }, [access.write.allowed, confirmed, source?.data, source?.dataUpdatedAt, window]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      approval.current = undefined;
      selected.current = undefined;
      flight.current?.abort();
      flight.current = undefined;
      followup.current?.abort();
      refreshFlight.current?.abort();
    };
  }, []);
  function current() {
    access.assertOwned();
    if (!mounted.current) throw draftStopped();
  }
  function sourceApproval(target: Selection): Approval {
    current();
    access.write.assertCurrent();
    const state = client.getQueryState(["governance", "advisor", latest.current.window]);
    if (
      !latest.current.confirmed ||
      state?.status !== "success" ||
      state.fetchStatus !== "idle" ||
      state.isInvalidated
    )
      throw draftStopped();
    return {
      selection: target,
      data: state.data,
      window: latest.current.window,
      updated: state.dataUpdatedAt,
    };
  }
  function approve(target: Selection) {
    const next = sourceApproval(target);
    approval.current = next;
    setReview(next);
  }
  function open(row: PolicySuggestion, trigger: HTMLButtonElement) {
    try {
      if (selected.current || flight.current) return;
      current();
      access.write.assertCurrent();
      const now = client.getQueryState(["governance", "advisor", window]);
      if (
        now?.data !== source?.data ||
        now?.dataUpdatedAt !== source?.dataUpdatedAt ||
        latest.current.window !== window
      )
        return;
      const target = { snapshot: policyDraftSnapshot(row, latest.current.window), trigger };
      approve(target);
      selected.current = target;
      setSelection(target);
      setOutcome({ kind: "idle" });
    } catch {
      /* Closed or no longer eligible: no request or retained raw error. */
    }
  }
  function close() {
    if (!selection || selected.current !== selection || flight.current) return;
    followup.current?.abort();
    followup.current = undefined;
    refreshFlight.current?.abort();
    refreshFlight.current = undefined;
    setRefreshResult({ window: latest.current.window, status: "idle" });
    selected.current = undefined;
    approval.current = undefined;
    setSelection(undefined);
    setReview(undefined);
    setOutcome({ kind: "idle" });
  }
  function rereview() {
    try {
      if (selection && selected.current === selection && !flight.current) approve(selection);
    } catch {
      /* Current lock stays. */
    }
  }
  async function refreshSuggestions() {
    const target = selection;
    if (!target || selected.current !== target) return;
    try {
      current();
      access.assertSuggestionsRead();
    } catch {
      return;
    }
    if (refreshFlight.current || flight.current) return;
    const active = new AbortController();
    const requestedWindow = latest.current.window;
    refreshFlight.current = active;
    approval.current = undefined;
    setReview(undefined);
    setRefreshResult({ window: requestedWindow, status: "pending" });
    const stillCurrent = () => {
      current();
      access.assertSuggestionsRead();
      if (
        active.signal.aborted ||
        refreshFlight.current !== active ||
        selected.current !== target ||
        latest.current.window !== requestedWindow
      )
        throw draftStopped();
    };
    try {
      stillCurrent();
      const data = await apiClient.request(endpoints.domains.governance.advisor.suggestions, {
        query: { window: requestedWindow },
        signal: active.signal,
        routeId: "governance.policies",
      });
      stillCurrent();
      client.setQueryData(["governance", "advisor", requestedWindow], data);
      setRefreshResult({ window: requestedWindow, status: "idle" });
    } catch {
      try {
        stillCurrent();
      } catch {
        return;
      }
      setRefreshResult({ window: requestedWindow, status: "error" });
    } finally {
      if (refreshFlight.current === active) {
        refreshFlight.current = undefined;
        try {
          current();
          // Release only this request's busy state, never publish a rejected response.
          if (latest.current.window === requestedWindow)
            setRefreshResult((previous) =>
              previous.window === requestedWindow && previous.status === "pending"
                ? { window: requestedWindow, status: "idle" }
                : previous,
            );
        } catch {
          /* A disposed owner cannot update the replacement instance. */
        }
      }
    }
  }
  async function submit() {
    const target = selection;
    const approved = review;
    if (!target || !approved || flight.current || committed.current === target) return;
    try {
      current();
      access.write.assertCurrent();
      if (selected.current !== target || approval.current !== approved) return;
      const state = sourceApproval(target);
      if (
        state.data !== approved.data ||
        state.window !== approved.window ||
        state.updated !== approved.updated
      )
        return;
    } catch {
      return;
    }
    const active = new AbortController();
    flight.current = active;
    setOutcome({ kind: "pending" });
    const owns = () => {
      current();
      if (flight.current !== active || selected.current !== target || active.signal.aborted)
        throw draftStopped();
    };
    try {
      const body = structuredClone(target.snapshot.body);
      owns();
      access.write.assertCurrent();
      if (approval.current !== approved) throw draftStopped();
      const latestSource = sourceApproval(target);
      if (
        latestSource.data !== approved.data ||
        latestSource.window !== approved.window ||
        latestSource.updated !== approved.updated
      )
        throw draftStopped();
      const result = await apiClient.request(endpoints.domains.governance.advisor.apply, {
        body,
        signal: active.signal,
        routeId: "governance.policies",
      });
      owns();
      if (!policyDraftAcknowledged(result)) {
        setOutcome({ kind: "error", message: "생성 여부를 확인할 수 없습니다.", uncertain: true });
        return;
      }
      // Acknowledged commit remains a success even after readonly/write withdrawal.
      // Invalidation never launches an unrelated route's query automatically.
      committed.current = target;
      flight.current = undefined;
      setOutcome({ kind: "success", refreshFailed: false });
      void client.invalidateQueries({ queryKey: ["governance", "policies"], refetchType: "none" });
      void refreshCommitted(target);
    } catch (cause) {
      try {
        owns();
      } catch {
        return;
      }
      setOutcome({
        kind: "error",
        uncertain: true,
        message: safeAppErrorMessage(cause, "초안 생성 결과를 확인하지 못했습니다."),
        requestId: isAppError(cause) ? cause.requestId : undefined,
      });
    } finally {
      if (flight.current === active) flight.current = undefined;
    }
  }
  async function refreshCommitted(target: Selection) {
    if (followup.current) return;
    const active = new AbortController();
    followup.current = active;
    const stillOpen = () => {
      current();
      if (selected.current !== target || followup.current !== active || active.signal.aborted)
        throw draftStopped();
    };
    try {
      stillOpen();
      access.assertRead();
      const policies = await apiClient.request(endpoints.domains.governance.policies.list, {
        signal: active.signal,
        routeId: "governance.policies",
      });
      stillOpen();
      access.assertRead();
      client.setQueryData(["governance", "policies"], policies);
      setOutcome({ kind: "success", refreshFailed: false });
    } catch {
      try {
        stillOpen();
      } catch {
        return;
      }
      setOutcome({ kind: "success", refreshFailed: true });
    } finally {
      if (followup.current === active) followup.current = undefined;
    }
  }
  return {
    selection,
    outcome,
    open,
    close,
    rereview,
    submit,
    refreshSuggestions,
    refreshState,
    retryPolicyRead: () => {
      if (selection && committed.current === selection) void refreshCommitted(selection);
    },
    canOpen: access.write.allowed && confirmed,
    canSubmit: access.write.allowed && confirmed && review !== undefined,
    canReview: access.write.allowed && confirmed,
    reason: access.write.reason ?? (!confirmed || !review ? draftSourceReason : undefined),
  };
}
