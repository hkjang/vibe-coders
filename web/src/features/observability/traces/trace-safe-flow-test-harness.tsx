import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { TracePage } from "./TracePage";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { usePreferences } from "@/shared/stores/preferences";
import type { AuthMode } from "@/app/auth/AuthProvider";

const authRuntime = vi.hoisted(() => ({
  mode: "authenticated" as AuthMode,
  userPresent: true,
  id: "reader-a",
  role: "admin",
  scopes: ["admin:read"],
  prefixes: ["corp_"],
  owner: "observability.traces",
  permitted: true,
  readOnly: true,
}));
export const runtime = authRuntime;
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: authRuntime.mode,
    authenticationMode:
      authRuntime.mode === "legacy" ? "legacy_token" : authRuntime.mode === "open" ? "open" : "session",
    credentialPrefixes: authRuntime.prefixes,
    features: [],
    backendVersion: "v0.86.33",
    legacyFallback: false,
    user: authRuntime.userPresent
      ? {
          id: authRuntime.id,
          role: authRuntime.role,
          roles: [authRuntime.role],
          scopes: authRuntime.scopes,
          team_id: "team-a",
        }
      : undefined,
  }),
}));

export const requestRef = `req_${"a".repeat(22)}.${"b".repeat(21)}`;
export const recordedAt = "2026-10-01T01:02:03.123456789Z";
export const row = {
  request_id: "synthetic-request",
  request_ref: requestRef,
  request_filterable: true,
  trace_id: "trace-public",
  trace_filterable: true,
  session_id: "",
  api_key_id: "",
  ip: "",
  method: "POST",
  model: "test-model",
  provider_ref: `prv_${"p".repeat(43)}`,
  provider_display: "합성 공급자",
  endpoint: "/v1/chat/completions",
  stream: false,
  status_code: 200,
  latency_ms: 0,
  first_chunk_ms: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cached_tokens: 0,
  reasoning_tokens: 0,
  estimated_cost: 0,
  currency: "KRW",
  finish_reason: "",
  created_at: recordedAt,
};
export const list = { requests: [row], limit: 50, generated_at: recordedAt };
export const rootRef = `span_${"r".repeat(43)}`;
export const flow = {
  flow_version: 1,
  request_ref: requestRef,
  created_at: recordedAt,
  generated_at: recordedAt,
  spans: [
    {
      span_ref: rootRef,
      parent_ref: null,
      kind: "request",
      name: "요청 기록",
      status: "ok",
      recorded_at: recordedAt,
      offset_ms: 0,
      duration_ms: 0,
    },
  ],
  coverage: {
    tools: { limit: 100, truncated: false, omitted: 0 },
    text2sql: { limit: 100, truncated: false, omitted: 0 },
  },
};
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function renderTrace(
  initialFlow?: () => Promise<unknown>,
  timeZone = "Asia/Seoul",
  actualRoute = false,
  initialAuth: Partial<Pick<typeof runtime, "mode" | "userPresent" | "id" | "role" | "scopes">> = {},
) {
  Object.assign(runtime, {
    mode: "authenticated",
    userPresent: true,
    id: "reader-a",
    role: "admin",
    scopes: ["admin:read"],
    prefixes: ["corp_"],
    owner: "observability.traces",
    permitted: true,
    readOnly: true,
    ...initialAuth,
  });
  usePreferences.setState({ refreshInterval: 0 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls: Array<{ path: string; query: unknown; signal?: AbortSignal }> = [];
  let response: () => Promise<unknown> = initialFlow ?? (async () => structuredClone(flow));
  let listResponse: () => Promise<unknown> = async () => structuredClone(list);
  vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, options) => {
    calls.push({ path: endpoint.path, query: options?.query, signal: options?.signal });
    // Transport simulation intentionally does not enforce UI permission or abort guards.
    const value = await (endpoint.path === "/admin/requests" ? listResponse() : response());
    const parsed = endpoint.schema.safeParse(value);
    if (!parsed.success) throw new AppError("합성 응답 계약 오류", { kind: "contract" });
    return parsed.data;
  });
  const feature = migrationRegistry.find((value) => value.featureId === "observability.traces");
  if (!feature) throw new Error("Missing trace feature fixture");
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[
          `/observability/traces?selected_request=synthetic-request&tz=${encodeURIComponent(timeZone)}`,
        ]}
      >
        {actualRoute ? (
          <FeatureRoute feature={{ ...feature, serverAvailable: true }}>
            <TracePage />
          </FeatureRoute>
        ) : (
          <FeatureAccessContext.Provider
            value={{ featureId: runtime.owner, permitted: runtime.permitted, readOnly: runtime.readOnly }}
          >
            <TracePage />
          </FeatureAccessContext.Provider>
        )}
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    client,
    calls,
    rerenderRuntime: () => view.rerender(tree()),
    reply: (next: () => Promise<unknown>) => {
      response = next;
    },
    replyList: (next: () => Promise<unknown>) => {
      listResponse = next;
    },
    flowCalls: () => calls.filter((call) => call.path === "/admin/app/request-flow"),
  };
}
