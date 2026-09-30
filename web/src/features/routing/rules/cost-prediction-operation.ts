import { useLayoutEffect, useRef, useState } from "react";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import type { CostPredictionAccess } from "./cost-prediction-access";
import { prepareCostDraft, type CostDraft, type CostErrors, type CostState } from "./cost-prediction-state";

export function useCostPredictionOperation(access: CostPredictionAccess) {
  const [state, setState] = useState<CostState>({ kind: "idle" });
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
  async function run(readDraft: () => CostDraft, onValidation: (errors: CostErrors) => void): Promise<void> {
    if (!mounted.current || flight.current) return;
    try {
      access.assertPredict();
    } catch {
      return;
    }
    const { snapshot, errors } = prepareCostDraft(readDraft());
    try {
      access.assertPredict();
    } catch {
      return;
    }
    if (!mounted.current) return;
    onValidation(errors);
    if (!snapshot) return;
    const current = new AbortController();
    flight.current = current;
    const isCurrent = () => {
      if (!mounted.current || flight.current !== current || current.signal.aborted) return false;
      try {
        access.assertOwned();
        return true;
      } catch {
        return false;
      }
    };
    const canReceive = () => {
      if (!isCurrent()) return false;
      try {
        access.assertPredict();
        return true;
      } catch {
        return false;
      }
    };
    setState({ kind: "pending", snapshot });
    try {
      access.assertPredict();
      const result = await apiClient.request(endpoints.domains.routing.costPredict, {
        body: snapshot.body,
        signal: current.signal,
        routeId: "routing.rules",
      });
      if (canReceive()) setState({ kind: "success", snapshot, result });
    } catch (cause) {
      if (canReceive())
        setState({
          kind: "error",
          snapshot,
          message: safeAppErrorMessage(cause, "비용을 예측하지 못했습니다."),
          requestId: isAppError(cause) ? cause.requestId : undefined,
        });
    } finally {
      if (flight.current === current) {
        const owned = isCurrent();
        flight.current = null;
        // A permission-withheld response is not "never calculated". Keep only
        // its local basis and require a new explicit action after recovery.
        if (owned)
          setState((previous) =>
            previous.kind === "pending" && previous.snapshot === snapshot
              ? { kind: "withheld", snapshot }
              : previous,
          );
      }
    }
  }
  return { state, run };
}
