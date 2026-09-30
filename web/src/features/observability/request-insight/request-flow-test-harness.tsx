import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext, useEffect, useState } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, vi } from "vitest";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { RouteQueryGuard } from "@/app/guards/RouteQueryGuard";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { RequestSpanWaterfall } from "./RequestSpanWaterfall";

export type FlowMode = "preview" | "read_only" | "preview_read_only";
const runtime = vi.hoisted(() => ({
  mode: "preview" as FlowMode,
  userId: "flow-user-a",
  scopes: ["admin:read"],
  credentialPrefixes: ["vc_sk_", "vc_sa_"],
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: runtime.scopes, user: { id: runtime.userId } });
      return {
        ...auth,
        credentialPrefixes: runtime.credentialPrefixes,
        features: auth.features.map((feature) =>
          feature.featureId === "observability.llm"
            ? {
                ...feature,
                status: runtime.mode === "preview_read_only" ? "preview_read_only" : "preview",
                readOnly: runtime.mode === "read_only",
              }
            : feature,
        ),
      };
    },
  };
});

export const firstRequest = "flow-request-a";
export const traceKey = (id = firstRequest) => ["observability", "requests", id, "trace"];
export const linksKey = (id = firstRequest) => ["observability", "requests", id, "links"];
export const rootName = "공개 요청 모델";
export const toolName = "문서 검색 도구";
export function rootSpan(overrides: Record<string, unknown> = {}, requestId = firstRequest) {
  return {
    span_id: `span:req:${requestId}`,
    name: rootName,
    kind: "request",
    status: "ok",
    start_offset_ms: 0,
    duration_ms: 120,
    ...overrides,
  };
}
export function toolSpan(overrides: Record<string, unknown> = {}, requestId = firstRequest) {
  return {
    span_id: "span:tool:public-tool",
    parent_span_id: `span:req:${requestId}`,
    name: toolName,
    kind: "mcp_tool",
    status: "ok",
    start_offset_ms: 0,
    // The existing server does not record per-call duration; this is not a
    // measurement that proves instant execution or simultaneous starts.
    duration_ms: 0,
    ...overrides,
  };
}
export function text2sqlSpan(overrides: Record<string, unknown> = {}) {
  return {
    span_id: "span:t2s:public-stage",
    parent_span_id: `span:req:${firstRequest}`,
    name: "text2sql:execute",
    kind: "text2sql",
    status: "ok",
    start_offset_ms: 300,
    duration_ms: 40,
    ...overrides,
  };
}
export function traceFixture(overrides: Record<string, unknown> = {}) {
  const requestId = typeof overrides.request_id === "string" ? overrides.request_id : firstRequest;
  return {
    request_id: requestId,
    trace_id: "flow-trace-public",
    total_ms: 120,
    spans: [rootSpan({}, requestId), toolSpan({}, requestId)],
    ...overrides,
  };
}
export function linksFixture(overrides: Record<string, unknown> = {}) {
  return {
    request_id: firstRequest,
    trace_id: "flow-trace-public",
    session_id: "flow-session-public",
    counts: { tools: 1, mcp_tools: 1, text2sql_spans: 0, tool_errors: 0 },
    governance: { blocked: false },
    ...overrides,
  };
}
export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function flowCard(): HTMLElement {
  const card = screen.getByRole("heading", { name: "처리 흐름" }).closest("section");
  if (!card) throw new Error("missing request flow card");
  return card;
}
export function flowRow(name: string): HTMLElement {
  const row = screen.getByText(name, { selector: "code" }).closest("li");
  if (!row) throw new Error("missing request flow row");
  return row;
}

beforeEach(() => {
  runtime.mode = "preview";
  runtime.userId = "flow-user-a";
  runtime.scopes = ["admin:read"];
  runtime.credentialPrefixes = ["vc_sk_", "vc_sa_"];
  tokenStore.clearAll();
});
afterEach(() => vi.restoreAllMocks());

export function setupFlow(
  options: {
    mode?: FlowMode;
    initialRequestId?: string;
    trace?: (id: string) => unknown;
    links?: (id: string) => unknown;
  } = {},
) {
  runtime.mode = options.mode ?? "preview";
  const response = {
    trace: options.trace ?? ((id: string) => traceFixture({ request_id: id })),
    links: options.links ?? ((id: string) => linksFixture({ request_id: id })),
  };
  const attempts: Array<{ method: string; path: string; signal?: AbortSignal; routeId?: string }> = [];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, ...args) => {
    const metadata = args[0] as { signal?: AbortSignal; routeId?: string } | undefined;
    attempts.push({ method: endpoint.method, path: endpoint.path, ...metadata });
    const match = /^\/admin\/requests\/([^/]+)\/(trace|links)$/u.exec(endpoint.path);
    const encodedId = match?.[1];
    const endpointKind = match?.[2];
    if (endpoint.method !== "GET" || !encodedId || (endpointKind !== "trace" && endpointKind !== "links"))
      throw new AppError("unexpected fixture API", { kind: "contract" });
    const id = decodeURIComponent(encodedId);
    const epoch = tokenStore.getSessionEpoch();
    const assertCurrent = () => {
      if (epoch !== tokenStore.getSessionEpoch() || metadata?.signal?.aborted)
        throw new AppError("discarded prior request", { kind: "aborted" });
    };
    try {
      assertCurrent();
      const body = await response[endpointKind](id);
      assertCurrent();
      // Reuse the actual loose adapter. No fixture permission enforcement,
      // redaction, missing-field repair, invented duration, or automatic retry.
      // Session/abort checks preserve existing shared-client transport defenses;
      // these tests are not actual Go/HTTP/DB/browser evidence.
      return endpoint.schema.parse(body) as never;
    } catch (cause) {
      assertCurrent();
      throw cause;
    }
  });
  let change: (value: { requestId?: string; revision?: boolean }) => void = () => undefined;
  function ContextProbe() {
    const access = useContext(FeatureAccessContext);
    return <output data-testid="flow-access">{`${access?.featureId}:${String(access?.readOnly)}`}</output>;
  }
  function LocationProbe() {
    const location = useLocation();
    return <output data-testid="flow-location">{location.pathname + location.search}</output>;
  }
  function Host() {
    const [requestId, setRequestId] = useState(options.initialRequestId ?? firstRequest);
    const [, setRevision] = useState(0);
    useEffect(() => {
      change = (value) => {
        if (value.requestId !== undefined) setRequestId(value.requestId);
        if (value.revision) setRevision((current) => current + 1);
      };
      return () => {
        change = () => undefined;
      };
    }, []);
    const feature = migrationRegistry.find((candidate) => candidate.featureId === "observability.llm");
    if (!feature) throw new Error("missing LLM feature");
    return (
      <FeatureRoute feature={feature}>
        <ContextProbe />
        {/* Real LLM/XView callers key RequestInsightPanel by request ID. */}
        <RequestSpanWaterfall key={requestId} requestId={requestId} />
      </FeatureRoute>
    );
  }
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter basename="/app" initialEntries={["/app/observability/llm"]}>
        <LocationProbe />
        <Routes>
          <Route element={<RouteQueryGuard />}>
            <Route path="/observability/llm" element={<Host />} />
            <Route path="/observability/xview" element={<h1>기존 세션 화면 경로</h1>} />
            <Route path="*" element={<h1>일치하지 않는 경로</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return {
    attempts,
    client,
    response,
    view,
    user: userEvent.setup(),
    count(kind: "trace" | "links") {
      return attempts.filter((item) => item.path.endsWith(`/${kind}`)).length;
    },
    update(values: Partial<typeof runtime>) {
      act(() => {
        Object.assign(runtime, values);
        change({ revision: true });
      });
    },
    selectRequest(id: string) {
      act(() => change({ requestId: id }));
    },
    nextSession(id: string) {
      act(() => {
        // Match the existing AuthProvider's synchronous credential/cache discard,
        // not a newly implemented defense in this display component.
        tokenStore.clearAll();
        client.clear();
        runtime.userId = "flow-user-b";
        change({ requestId: id, revision: true });
      });
    },
  };
}
