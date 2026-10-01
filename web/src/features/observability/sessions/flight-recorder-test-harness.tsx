import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { Children, forwardRef, useContext, type MouseEvent } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { vi } from "vitest";
import type { AuthMode } from "@/app/auth/AuthProvider";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { createAppQueryClient } from "@/app/providers/query-client";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import type * as ButtonModule from "@/shared/components/ui/Button";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { usePreferences } from "@/shared/stores/preferences";
import * as csv from "@/shared/utils/csv";
import { FlightRecorderPanel } from "./FlightRecorderPanel";
import { SessionPage } from "./SessionPage";

const state = vi.hoisted(() => ({
  mode: "authenticated" as AuthMode,
  userPresent: true,
  id: "reader-a",
  team: "team-a",
  role: "admin",
  scopes: ["admin:read"],
  prefixes: ["corp_"],
  owner: "observability.sessions",
  permitted: true,
  readOnly: true,
}));
export const runtime = state;
const observed = vi.hoisted(() => ({
  callbacks: new Map<string, () => void>(),
  readOnly: undefined as boolean | undefined,
}));
vi.mock("@/shared/components/ui/Button", async (original) => {
  const actual = await original<typeof ButtonModule>();
  return {
    ...actual,
    Button: forwardRef<HTMLButtonElement, ButtonModule.ButtonProps>(function ObservedButton(props, ref) {
      const label = Children.toArray(props.children)
        .filter((child) => typeof child === "string")
        .join("")
        .trim();
      if (props.onClick) {
        const handler = props.onClick;
        observed.callbacks.set(label, () => handler({} as MouseEvent<HTMLButtonElement>));
      }
      return <actual.Button {...props} ref={ref} />;
    }),
  };
});
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const base = testAuth({
        scopes: runtime.scopes,
        role: runtime.role,
        legacyFallback: false,
        user: { id: runtime.id, team_id: runtime.team },
      });
      return {
        ...base,
        mode: runtime.mode,
        user: runtime.userPresent ? base.user : undefined,
        credentialPrefixes: runtime.prefixes,
        features: base.features.map((entry) =>
          entry.featureId === "observability.sessions"
            ? { ...entry, serverAvailable: true, readOnly: runtime.readOnly }
            : entry,
        ),
      };
    },
  };
});

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const response = (displayId = "sess-alpha") => ({
  session_id: displayId,
  summary: { verdict: "정상", headline: "합성 서버 요약", findings: [] as string[] },
  rollup: {
    requests: 1,
    started_at: "2026-10-01T01:00:00Z",
    ended_at: "2026-10-01T01:00:01Z",
    models: ["model-a"],
    providers: ["provider-a"],
  },
  events: [
    {
      created_at: "2026-10-01T01:00:00Z",
      request_id: "req-a",
      trace_id: "trace-a",
      kind: "chat",
      endpoint: "/v1/chat",
      model: "model-a",
      provider: "provider-a",
      status_code: 200,
      latency_ms: 1,
      total_tokens: 2,
      cost_krw: 3,
      tool_count: 0,
      secret_events: 0,
      policy_blocks: 0,
      code_risk: "",
      last_message: "NOT_A_CSV_COLUMN",
    },
  ],
});
export const failure = (requestId = "safe-request-1", retryable = false) =>
  new AppError("합성 서버 오류", { kind: "http", status: 503, requestId, retryable });

/** Transport attempts are recorded before any reply. No permission, abort, target or freshness enforcement. */
export function renderRecorder(
  options: {
    target?: string;
    page?: boolean;
    route?: string;
    actualRoute?: boolean;
    auth?: Partial<typeof runtime>;
    reply?: (target: string) => Promise<unknown>;
  } = {},
) {
  Object.assign(runtime, {
    mode: "authenticated",
    userPresent: true,
    id: "reader-a",
    team: "team-a",
    role: "admin",
    scopes: ["admin:read"],
    prefixes: ["corp_"],
    owner: "observability.sessions",
    permitted: true,
    readOnly: true,
    ...options.auth,
  });
  observed.callbacks.clear();
  observed.readOnly = undefined;
  usePreferences.setState({ refreshInterval: 0 });
  const client = createAppQueryClient();
  // Keep production retry/focus defaults. Only scheduling delay is shortened for deterministic tests.
  client.setDefaultOptions({
    ...client.getDefaultOptions(),
    queries: { ...client.getDefaultOptions().queries, retryDelay: 0 },
  });
  const calls: Array<{ path: string; signal?: AbortSignal; routeId?: string }> = [];
  const downloads: Array<{ name: string; content: string }> = [];
  // Real toCsv serialization; actual Blob/anchor/revoke behavior belongs to the browser lane.
  vi.spyOn(csv, "downloadCsv").mockImplementation((name, content) => {
    downloads.push({ name, content });
  });
  let reply = options.reply ?? (async (target: string) => response(target));
  let listReply = async (days: number): Promise<unknown> => ({ days, sessions: [], note: "" });
  vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, request) => {
    calls.push({ path: endpoint.path, signal: request?.signal, routeId: request?.routeId });
    const match = /^\/admin\/sessions\/([^/]+)\/flight-recorder$/u.exec(endpoint.path);
    let raw: unknown;
    if (match?.[1]) raw = await reply(decodeURIComponent(match[1]));
    else if (endpoint.path === "/admin/sessions")
      raw = await listReply(Number(request?.query && "days" in request.query ? request.query.days : 7));
    else throw new Error("Unexpected recorder test endpoint");
    const parsed = endpoint.schema.safeParse(raw);
    if (!parsed.success) throw new AppError("합성 응답 계약 오류", { kind: "contract" });
    return parsed.data;
  });
  let target = options.target ?? "sess-alpha";
  let open = true;
  let navigate!: ReturnType<typeof useNavigate>;
  let search = "";
  function Navigation() {
    navigate = useNavigate();
    search = useLocation().search;
    return null;
  }
  function Content() {
    observed.readOnly = useContext(FeatureAccessContext)?.readOnly;
    return options.page ? <SessionPage /> : open ? <FlightRecorderPanel sessionId={target} /> : null;
  }
  const feature = migrationRegistry.find((entry) => entry.featureId === "observability.sessions");
  if (!feature) throw new Error("Missing sessions feature");
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/observability/sessions${options.route ?? ""}`]}>
        <Navigation />
        {options.actualRoute === false ? (
          <FeatureAccessContext.Provider
            value={{ featureId: runtime.owner, permitted: runtime.permitted, readOnly: runtime.readOnly }}
          >
            <Content />
          </FeatureAccessContext.Provider>
        ) : (
          <FeatureRoute feature={feature}>
            <Content />
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
    downloads,
    details: () => calls.filter((call) => call.path !== "/admin/sessions"),
    readOnly: () => observed.readOnly,
    search: () => search,
    navigate: (next: string) => navigate(`/observability/sessions${next}`),
    rerenderRuntime: () => view.rerender(tree()),
    target: (next: string) => {
      target = next;
      view.rerender(tree());
    },
    open: (next: boolean) => {
      open = next;
      view.rerender(tree());
    },
    reply: (next: typeof reply) => {
      reply = next;
    },
    listReply: (next: typeof listReply) => {
      listReply = next;
    },
    query: () => {
      const matches = client
        .getQueryCache()
        .findAll({ queryKey: ["observability", "sessions", "flight-recorder"] })
        .filter((query) => query.getObserversCount() > 0);
      const query = matches[0];
      if (matches.length !== 1 || !query) throw new Error("Expected exactly one active recorder Query");
      return query;
    },
    captured: (label = "CSV 내보내기") => {
      const callback = observed.callbacks.get(label);
      if (!callback) throw new Error(`Missing actual Button callback: ${label}`);
      return callback;
    },
  };
}
