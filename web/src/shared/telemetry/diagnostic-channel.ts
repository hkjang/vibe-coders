import { isAppError } from "@/shared/api/error";

type APIFailure = "http" | "auth" | "permission" | "contract" | "network" | "timeout";
type JSFailure =
  "error" | "type" | "range" | "reference" | "syntax" | "uri" | "eval" | "aggregate" | "unknown";
type DiagnosticMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type DiagnosticObservation =
  | {
      feature_id: string;
      kind: "api_error";
      endpoint: string;
      method: DiagnosticMethod;
      status: number;
      request_id?: string;
      failure: APIFailure;
    }
  | { feature_id: string; kind: "js_error"; boundary: "root" | "route"; failure: JSFailure };

interface Sink {
  feature: () => string | undefined;
  send: (event: DiagnosticObservation) => void;
  seenErrors: WeakSet<object>;
  startedAt: number;
  events: number;
}

let active: Sink | undefined;

/** Memory only, installed after opt-in/auth/version checks. No replay or queue. */
export function installDiagnosticSink(feature: Sink["feature"], send: Sink["send"]): () => void {
  const sink: Sink = { feature, send, seenErrors: new WeakSet(), startedAt: performance.now(), events: 0 };
  active = sink;
  return () => {
    if (active === sink) active = undefined;
  };
}

function emit(sink: Sink, event: DiagnosticObservation): void {
  if (active !== sink) return;
  const now = performance.now();
  if (now - sink.startedAt >= 60_000) {
    sink.startedAt = now;
    sink.events = 0;
  }
  if (sink.events >= 20) return;
  sink.events += 1;
  try {
    sink.send(event);
  } catch {
    /* Diagnostics must never change product behavior. */
  }
}

/** Capture only the original registry template, before parameters are bound. */
export function captureAPIError(endpoint: {
  method: string;
  diagnosticTemplate?: string;
}): ((error: unknown) => void) | undefined {
  const sink = active;
  const template = endpoint.diagnosticTemplate;
  const method = endpoint.method;
  if (
    method !== "GET" &&
    method !== "POST" &&
    method !== "PUT" &&
    method !== "PATCH" &&
    method !== "DELETE" &&
    method !== "HEAD"
  )
    return;
  if (
    !sink ||
    !template ||
    template.startsWith("/auth/") ||
    template.startsWith("/admin/ui-telemetry/") ||
    template.startsWith("/admin/ui-diagnostics/")
  )
    return;
  const feature = sink.feature();
  if (!feature) return;
  let reported = false;
  return (error) => {
    if (reported || !isAppError(error) || error.kind === "aborted") return;
    reported = true;
    const status = error.status ?? 0;
    if (!Number.isInteger(status) || (status !== 0 && (status < 100 || status > 599))) return;
    const requestID = /^trace_[0-9a-f]{32}$/.test(error.requestId ?? "") ? error.requestId : undefined;
    emit(sink, {
      feature_id: feature,
      kind: "api_error",
      endpoint: template,
      method,
      status,
      failure: error.kind,
      ...(requestID ? { request_id: requestID } : {}),
    });
  };
}

function classifyBoundaryError(error: unknown): JSFailure {
  // Names, messages and component stacks can be supplied by application data.
  if (error instanceof TypeError) return "type";
  if (error instanceof RangeError) return "range";
  if (error instanceof ReferenceError) return "reference";
  if (error instanceof SyntaxError) return "syntax";
  if (error instanceof URIError) return "uri";
  if (error instanceof EvalError) return "eval";
  if (error instanceof AggregateError) return "aggregate";
  return error instanceof Error ? "error" : "unknown";
}

/** False means the visible error could not yet be attributed to an opted-in session. */
export function reportBoundaryError(error: unknown, boundary: "root" | "route"): boolean {
  const sink = active;
  const feature = sink?.feature();
  if (!sink || !feature) return false;
  if (typeof error === "object" && error !== null) {
    if (sink.seenErrors.has(error)) return true;
    sink.seenErrors.add(error);
  }
  emit(sink, { feature_id: feature, kind: "js_error", boundary, failure: classifyBoundaryError(error) });
  return true;
}
