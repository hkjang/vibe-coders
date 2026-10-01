import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { vi } from "vitest";
import type { ComponentProps } from "react";
import { useContext } from "react";
import type { AuthMode } from "@/app/auth/AuthProvider";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import type { SessionSummary } from "@/shared/api/domains/observability.schemas";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { usePreferences } from "@/shared/stores/preferences";
import type * as TableModule from "@/shared/data-table/DataTable";
import { SessionPage } from "./SessionPage";

const state = vi.hoisted(() => ({
  mode: "authenticated" as AuthMode,
  userPresent: true,
  id: "reader-a",
  team: "team-a",
  scopes: ["admin:read"],
  prefixes: ["corp_"],
  role: "admin",
  owner: "observability.sessions",
  permitted: true,
  readOnly: true,
}));
export const runtime = state;
const observed = vi.hoisted(() => ({
  open: undefined as undefined | ((row: SessionSummary) => void),
  rows: [] as readonly SessionSummary[],
  readOnly: undefined as boolean | undefined,
}));
export const table = observed;
vi.mock("@/shared/data-table/DataTable", async (original) => {
  const actual = await original<typeof TableModule>();
  return {
    ...actual,
    DataTable: (props: ComponentProps<typeof actual.DataTable<SessionSummary>>) => {
      observed.open = props.onRowClick;
      observed.rows = props.data;
      return <actual.DataTable {...props} />;
    },
  };
});
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const base = testAuth({
        scopes: state.scopes,
        role: state.role,
        legacyFallback: false,
        user: { id: state.id, team_id: state.team },
      });
      return {
        ...base,
        mode: state.mode,
        credentialPrefixes: state.prefixes,
        user: state.userPresent ? base.user : undefined,
        features: base.features.map((feature) =>
          feature.featureId === "observability.sessions"
            ? { ...feature, serverAvailable: true, readOnly: state.readOnly }
            : feature,
        ),
      };
    },
  };
});
export const row = {
  session_id: "sess-alpha",
  requests: 12,
  first_seen: "2026-10-01T01:00:00Z",
  last_seen: "2026-10-01T02:00:00Z",
  models: 1,
  api_keys: 1,
  errors: 1,
  total_tokens: 300,
  cost_krw: 380,
  last_message: "합성 메시지",
};
export const list = (days = 7) => ({ days, sessions: [structuredClone(row)], note: "" });
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function renderSessions(
  options: {
    route?: string;
    actualRoute?: boolean;
    auth?: Partial<typeof runtime>;
    initialList?: (days: number) => Promise<unknown>;
  } = {},
) {
  Object.assign(runtime, {
    mode: "authenticated",
    userPresent: true,
    id: "reader-a",
    team: "team-a",
    scopes: ["admin:read"],
    prefixes: ["corp_"],
    role: "admin",
    owner: "observability.sessions",
    permitted: true,
    readOnly: true,
    ...options.auth,
  });
  table.open = undefined;
  table.rows = [];
  usePreferences.setState({ refreshInterval: 0 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls: Array<{ path: string; query: unknown; signal?: AbortSignal; routeId?: string }> = [];
  let reply = options.initialList ?? (async (days: number) => list(days));
  vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, request) => {
    // Attempts precede parsing/response processing; no fixture permission, freshness, or abort enforcement.
    calls.push({
      path: endpoint.path,
      query: request?.query,
      signal: request?.signal,
      routeId: request?.routeId,
    });
    if (
      endpoint.path !== "/admin/sessions" &&
      !/^\/admin\/sessions\/[^/]+\/flight-recorder$/u.test(endpoint.path)
    )
      throw new Error("Unexpected test endpoint");
    const value =
      endpoint.path === "/admin/sessions"
        ? await reply(Number(request?.query && "days" in request.query ? request.query.days : undefined))
        : {
            session_id: "sess-alpha",
            events: [],
            summary: { verdict: "확인", headline: "합성 상세", findings: [] },
            rollup: { requests: 0 },
          };
    const parsed = endpoint.schema.safeParse(value);
    if (!parsed.success) throw new AppError("합성 응답 계약 오류", { kind: "contract" });
    return parsed.data;
  });
  let navigate!: ReturnType<typeof useNavigate>;
  let search = "";
  function Navigation() {
    navigate = useNavigate();
    search = useLocation().search;
    return null;
  }
  function Content() {
    observed.readOnly = useContext(FeatureAccessContext)?.readOnly;
    return <SessionPage />;
  }
  const feature = migrationRegistry.find((item) => item.featureId === "observability.sessions");
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
          <FeatureRoute feature={{ ...feature, serverAvailable: true }}>
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
    search: () => search,
    navigate: (next: string) => navigate(`/observability/sessions${next}`),
    history: (delta: number) => navigate(delta),
    runtime: () => view.rerender(tree()),
    reply: (next: typeof reply) => {
      reply = next;
    },
    lists: () => calls.filter((call) => call.path === "/admin/sessions"),
    details: () => calls.filter((call) => call.path !== "/admin/sessions"),
    refresh: () =>
      client.refetchQueries({
        queryKey: ["observability", "sessions"],
        type: "active",
        predicate: (query) => query.queryKey[2] !== "flight-recorder",
      }),
    query: () => {
      const active = client
        .getQueryCache()
        .findAll({ queryKey: ["observability", "sessions"] })
        .filter((query) => query.queryKey[2] !== "flight-recorder" && query.getObserversCount() > 0);
      if (active.length !== 1) throw new Error("Expected exactly one active session list query");
      return active[0];
    },
  };
}
