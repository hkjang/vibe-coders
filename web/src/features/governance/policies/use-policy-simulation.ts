import { useLayoutEffect, useRef, useState } from "react";
import { apiClient } from "@/shared/api/client";
import type { PolicySuggestion } from "@/shared/api/domains/governance";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import type { PolicySimulationAccess } from "./policy-simulation-access";
import {
  simulationAggregate,
  simulationSnapshot,
  type SimulationAggregate,
  type SimulationSnapshot,
  type SimulationWindow,
} from "./policy-simulation-state";

type SimulationState =
  | { kind: "idle" }
  | { kind: "pending"; snapshot: SimulationSnapshot }
  | { kind: "success"; snapshot: SimulationSnapshot; result: SimulationAggregate }
  | { kind: "error"; snapshot: SimulationSnapshot; message: string; requestId?: string };

export function usePolicySimulation(access: PolicySimulationAccess, window: SimulationWindow) {
  const [state, setState] = useState<SimulationState>({ kind: "idle" });
  const mounted = useRef(false);
  const flight = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current?.abort();
      flight.current = null;
    };
  }, []);
  async function execute(prepare: () => SimulationSnapshot): Promise<void> {
    if (!mounted.current || flight.current) return;
    try {
      access.assertCurrent();
    } catch {
      return;
    }
    const current = new AbortController();
    flight.current = current;
    const active = () => {
      if (!mounted.current || flight.current !== current || current.signal.aborted) return false;
      try {
        access.assertCurrent();
        return true;
      } catch {
        return false;
      }
    };
    let snapshot: SimulationSnapshot | undefined;
    try {
      snapshot = prepare();
      const body = {
        rules: [
          {
            name: snapshot.title,
            conditions: structuredClone(snapshot.conditions),
            actions: structuredClone(snapshot.actions),
          },
        ],
        window: snapshot.window,
      };
      if (!active()) return;
      setState({ kind: "pending", snapshot });
      const result = await apiClient.request(endpoints.domains.governance.policies.simulate, {
        body,
        signal: current.signal,
        routeId: "governance.policies",
      });
      if (active()) setState({ kind: "success", snapshot, result: simulationAggregate(result) });
    } catch (cause) {
      if (snapshot && active())
        setState({
          kind: "error",
          snapshot,
          message: safeAppErrorMessage(cause, "잠시 후 다시 시도해 주세요."),
          requestId: isAppError(cause) ? cause.requestId : undefined,
        });
    } finally {
      if (flight.current === current) flight.current = null;
    }
  }
  return {
    state,
    run: (row: PolicySuggestion) => execute(() => simulationSnapshot(row, window)),
    retry: () => (state.kind === "error" ? execute(() => state.snapshot) : Promise.resolve()),
    close: () => setState({ kind: "idle" }),
  };
}
