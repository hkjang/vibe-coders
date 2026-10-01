import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import { vi } from "vitest";
import { RequestPage } from "./RequestPage";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { migrationRegistry } from "@/config/migration-registry";
import { usePreferences } from "@/shared/stores/preferences";
import type { AuthMode } from "@/app/auth/AuthProvider";
import type { ComponentProps } from "react";
import type * as ButtonModule from "@/shared/components/ui/Button";

const clickRuntime = vi.hoisted(() => new Map<string, () => void>());
export const capturedClicks = clickRuntime;
vi.mock("@/shared/components/ui/Button", async (importOriginal) => {
  const actual = await importOriginal<typeof ButtonModule>();
  return {
    ...actual,
    Button: function ObservedButton(props: ComponentProps<typeof actual.Button>) {
      const label = props["aria-label"] ?? (typeof props.children === "string" ? props.children : undefined);
      if (label && props.onClick) {
        const callback = props.onClick;
        clickRuntime.set(label, () => Reflect.apply(callback, undefined, []));
      }
      return <actual.Button {...props} />;
    },
  };
});

const authRuntime = vi.hoisted(() => ({
  mode: "authenticated" as AuthMode,
  userPresent: true,
  id: "reader-a",
  team: "team-a",
  role: "admin",
  scopes: ["admin:read"],
  prefixes: ["corp_"],
  owner: "observability.requests",
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
          team_id: authRuntime.team,
        }
      : undefined,
  }),
}));
export const requestRef = `req_${"a".repeat(22)}.${"b".repeat(21)}`;
export const recordedAt = "2026-10-01T01:02:03.123456789Z";
export const row = {
  request_id: "[값 비공개]",
  request_ref: requestRef,
  request_filterable: false,
  trace_id: "",
  trace_filterable: false,
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
export const flow = {
  flow_version: 1,
  request_ref: requestRef,
  created_at: recordedAt,
  generated_at: recordedAt,
  spans: [
    {
      span_ref: `span_${"r".repeat(43)}`,
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
export function renderRequests(
  options: {
    actualRoute?: boolean;
    auth?: Partial<typeof runtime>;
    initialList?: () => Promise<unknown>;
  } = {},
) {
  capturedClicks.clear();
  Object.assign(runtime, {
    mode: "authenticated",
    userPresent: true,
    id: "reader-a",
    team: "team-a",
    role: "admin",
    scopes: ["admin:read"],
    prefixes: ["corp_"],
    owner: "observability.requests",
    permitted: true,
    readOnly: true,
    ...options.auth,
  });
  usePreferences.setState({ refreshInterval: 0 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls: Array<{ path: string; query: unknown; signal?: AbortSignal; routeId?: string }> = [];
  let replyFlow: () => Promise<unknown> = async () => structuredClone(flow);
  let replyList: () => Promise<unknown> = options.initialList ?? (async () => structuredClone(list));
  vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, request) => {
    // Observe attempts first; this transport does not implement UI permission, owner or abort guards.
    calls.push({
      path: endpoint.path,
      query: request?.query,
      signal: request?.signal,
      routeId: request?.routeId,
    });
    const value = await (endpoint.path === "/admin/requests" ? replyList() : replyFlow());
    const parsed = endpoint.schema.safeParse(value);
    if (!parsed.success) throw new AppError("합성 응답 계약 오류", { kind: "contract" });
    return parsed.data;
  });
  const feature = migrationRegistry.find((entry) => entry.featureId === "observability.requests");
  if (!feature) throw new Error("Missing requests feature");
  let navigate!: ReturnType<typeof useNavigate>;
  function Navigation() {
    navigate = useNavigate();
    return null;
  }
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/observability/requests"]}>
        <Navigation />
        {options.actualRoute === false ? (
          <FeatureAccessContext.Provider
            value={{ featureId: runtime.owner, permitted: runtime.permitted, readOnly: runtime.readOnly }}
          >
            <RequestPage />
          </FeatureAccessContext.Provider>
        ) : (
          <FeatureRoute feature={{ ...feature, serverAvailable: true }}>
            <RequestPage />
          </FeatureRoute>
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
    navigate: (search: string) => navigate(`/observability/requests${search}`),
    replyFlow: (next: () => Promise<unknown>) => {
      replyFlow = next;
    },
    replyList: (next: () => Promise<unknown>) => {
      replyList = next;
    },
    flowCalls: () => calls.filter((call) => call.path === "/admin/app/request-flow"),
    listCalls: () => calls.filter((call) => call.path === "/admin/requests"),
    refresh: () => client.refetchQueries({ queryKey: ["admin", "requests"], type: "active" }),
  };
}
