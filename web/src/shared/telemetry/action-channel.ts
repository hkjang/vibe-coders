import { isAppError } from "@/shared/api/error";

/** Fixed operation classes only. Never derive a label from a payload, key or URL. */
export const actionKinds = [
  "save",
  "delete",
  "approve",
  "reject",
  "revoke",
  "rotate",
  "rollback",
  "activate",
  "deactivate",
  "import",
  "export",
  "run_request",
  "test",
  "feedback",
] as const;
export type ActionKind = (typeof actionKinds)[number];
export type ActionOutcome = "success" | "rejected" | "unknown";
export type ActionObservation = {
  feature_id: string;
  action: ActionKind;
  outcome: ActionOutcome;
};
export type ActionSelection<Variables> = ActionKind | false | ((variables: Variables) => ActionKind | false);
export interface ActionCompletion {
  success: () => void;
  failure: (error: unknown) => void;
}

interface Sink {
  feature: () => string | undefined;
  current: () => boolean;
  send: (event: ActionObservation) => void;
  startedAt: number;
  events: number;
}
let active: Sink | undefined;

/** Opt-in, memory only; replacing or retiring the sink discards outstanding observations. */
export function installActionSink(
  feature: Sink["feature"],
  current: Sink["current"],
  send: Sink["send"],
): () => void {
  const sink: Sink = { feature, current, send, startedAt: performance.now(), events: 0 };
  active = sink;
  return () => {
    if (active === sink) active = undefined;
  };
}

/** Capture before submission; completion never reads mutation variables or response bodies. */
export function captureAction<Variables>(
  selection: ActionSelection<Variables>,
  variables: Variables,
  ownsResult?: (() => boolean) | (() => void),
): ActionCompletion | undefined {
  const sink = active;
  if (!sink) return;
  try {
    if (!sink.current() || ownsResult?.() === false) return;
    const action = typeof selection === "function" ? selection(variables) : selection;
    const feature = sink.feature();
    if (!action || !actionKinds.includes(action) || !feature) return;
    let completed = false;
    const finish = (outcome: ActionOutcome) => {
      if (completed) return;
      completed = true;
      try {
        if (active !== sink || !sink.current() || ownsResult?.() === false) return;
        const now = performance.now();
        if (now - sink.startedAt >= 60_000) {
          sink.startedAt = now;
          sink.events = 0;
        }
        if (sink.events >= 20) return;
        sink.events += 1;
        sink.send({ feature_id: feature, action, outcome });
      } catch {
        /* Observation cannot change a product operation. */
      }
    };
    return {
      success: () => finish("success"),
      failure: (error) => {
        if (isAppError(error) && error.kind === "aborted") {
          completed = true;
          return;
        }
        // A lost/invalid response or server failure may follow an applied write.
        // Do not assert failure or inflate the known-outcome success denominator.
        const rejected =
          isAppError(error) &&
          ["auth", "permission", "http"].includes(error.kind) &&
          error.status !== undefined &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408;
        finish(rejected ? "rejected" : "unknown");
      },
    };
  } catch {
    return;
  }
}

/** Also usable by imperative, route-owned workflows outside TanStack Mutation. */
export async function observeAction<Result>(
  action: ActionKind | false,
  operation: () => Promise<Result>,
  ownsResult?: (() => boolean) | (() => void),
): Promise<Result> {
  const completion = captureAction(action, undefined, ownsResult);
  try {
    const result = await operation();
    completion?.success();
    return result;
  } catch (error) {
    completion?.failure(error);
    throw error;
  }
}
