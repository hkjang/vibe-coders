import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { ApiClient, apiClient } from "@/shared/api/client";
import { tokenStore } from "@/shared/auth/token-store";
import { renderScreen } from "@/test/render";
import { RoutingPage } from "./RoutingPage";

const authState = vi.hoisted(() => ({
  scopes: ["routing:read", "routing:write"],
  raw: true,
  user: "public-decision-reader",
  team: "public-team",
  prefixes: ["vc_sk_", "vc_sa_"],
  readOnly: false,
}));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({
        scopes: authState.scopes,
        rawPromptView: authState.raw,
        user: { id: authState.user, team_id: authState.team },
      });
      return {
        ...auth,
        credentialPrefixes: authState.prefixes,
        features: auth.features.map((feature) =>
          feature.featureId === "routing.rules" ? { ...feature, readOnly: authState.readOnly } : feature,
        ),
      };
    },
  };
});

export const decisionPath = "/admin/routing/domain-decisions";
export const decisionRow = {
  id: "dd_public_01",
  request_id: "req_public_01",
  user_id: "public-user",
  team_id: "public-team",
  query_hash: "public-query-hash",
  route: "public-sql-route",
  confidence: 1.12,
  tool_names: ["public-sql-candidate"],
  evidence_score: 2.25,
  evidence_count: 2,
  fallback_used: false,
  blocked_by_governance: false,
  reason: "공개 합성 결정 사유 01",
  created_at: "2026-10-08T00:00:00Z",
};
export const decisionSignal = {
  id: "signal_public_01",
  decision_id: decisionRow.id,
  source: "selector",
  route: decisionRow.route,
  score: 1.12,
  reason: "공개 합성 선택기 근거",
  created_at: "2026-10-08T00:00:01Z",
};
export const decisionReport = () => ({
  decisions: [{ ...decisionRow }],
  signals: { [decisionRow.id]: [{ ...decisionSignal }] },
});

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-ID": "public-response-id" },
  });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

beforeEach(() => {
  Object.assign(authState, {
    scopes: ["routing:read", "routing:write"],
    raw: true,
    user: "public-decision-reader",
    team: "public-team",
    prefixes: ["vc_sk_", "vc_sa_"],
    readOnly: false,
  });
  tokenStore.clearAll();
});
afterEach(() => vi.restoreAllMocks());

export function setupDomainDecisions(
  options: {
    decision?: () => Response | Promise<Response>;
    auth?: Partial<typeof authState>;
    search?: string;
  } = {},
) {
  Object.assign(authState, options.auth);
  const responses = { decision: options.decision ?? (() => jsonResponse(decisionReport())) };
  const calls: Array<{
    method: string;
    path: string;
    query: Record<string, string>;
    signal?: AbortSignal | null;
  }> = [];
  // Keep the real ApiClient query validation, response projection and HTTP errors.
  // This synthetic fetch records requests but never implements feature/UI guards.
  const transport = new ApiClient({
    fetch: async (input, init) => {
      const url = new URL(String(input), "https://synthetic.invalid");
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        signal: init?.signal,
      });
      if (method !== "GET") throw new Error("Read-only decision exploration attempted a write");
      if (url.pathname === decisionPath) return responses.decision();
      if (url.pathname === "/admin/routing/learning")
        return jsonResponse({
          since: "2026-10-01T00:00:00Z",
          min_samples: 20,
          cells: [],
          recommendations: [],
        });
      if (url.pathname === "/admin/routing/domain-review") return jsonResponse({ items: [] });
      if (url.pathname === "/admin/routing/domain-examples") return jsonResponse({ examples: [] });
      throw new Error(`Unexpected synthetic request: ${method} ${url.pathname}`);
    },
  });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  let renderAuth = () => {};
  let navigateTo: (search: string) => void = () => {};
  let locationSearch = "";
  const feature = migrationRegistry.find((candidate) => candidate.featureId === "routing.rules");
  if (!feature) throw new Error("Routing feature missing");
  const routingFeature = feature;
  function Host() {
    const [, setVersion] = useState(0);
    const location = useLocation();
    const navigate = useNavigate();
    useLayoutEffect(() => {
      navigateTo = (search) => {
        void navigate(`/routing/rules/learning${search}`);
      };
      locationSearch = location.search;
    }, [location.search, navigate]);
    useLayoutEffect(() => {
      renderAuth = () => setVersion((value) => value + 1);
    }, []);
    return (
      <FeatureRoute feature={routingFeature}>
        <RoutingPage />
      </FeatureRoute>
    );
  }
  const view = renderScreen(<Host />, {
    route: `/routing/rules/learning${options.search ?? ""}`,
    path: "/routing/rules/*",
  });
  const queries = () =>
    view.client
      .getQueryCache()
      .getAll()
      .filter(
        (query) =>
          query.queryKey[0] === "routing" &&
          query.queryKey[1] === "domain" &&
          query.queryKey[2] === "decisions",
      );
  const actualQuery = () => {
    const observed = queries().filter((query) => query.getObserversCount() > 0);
    expect(observed).toHaveLength(1);
    const query = observed[0];
    if (!query) throw new Error("Observed domain decision query missing");
    return query;
  };
  return {
    view,
    user: userEvent.setup(),
    responses,
    calls,
    queries,
    actualQuery,
    decisionCalls: () => calls.filter((call) => call.path === decisionPath),
    search: () => locationSearch,
    navigate(search: string) {
      act(() => navigateTo(search));
    },
    async settled(status: "success" | "error" = "success") {
      await waitFor(() => {
        expect(actualQuery().state.status).toBe(status);
        expect(actualQuery().state.fetchStatus).toBe("idle");
      });
    },
    section() {
      const section = screen.getByRole("heading", { name: "도메인 결정 로그" }).closest("section");
      if (!section) throw new Error("Domain decision section missing");
      return section;
    },
    update(patch: Partial<typeof authState>) {
      act(() => {
        Object.assign(authState, patch);
        renderAuth();
      });
    },
  };
}
