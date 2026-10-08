import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "@/app/auth/AuthProvider";
import { createAppQueryClient } from "@/app/providers/query-client";
import { XViewPage } from "@/features/observability/xview/XViewPage";
import { ApiClient, apiClient } from "@/shared/api/client";
import type { UIBootstrap } from "@/shared/api/schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessHarness } from "@/test/feature-access";

const requestId = "public-detail-owner-request";
const originalExplain = "PUBLIC-PRIVILEGED-EXPLAIN-ORIGINAL";
const originalTrace = "PUBLIC-PRIVILEGED-TRACE-ORIGINAL";
const clients: QueryClient[] = [];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

async function advance(milliseconds = 25) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}

async function click(element: HTMLElement) {
  fireEvent.click(element);
  await advance();
}

function AuthProbe(): React.JSX.Element {
  const auth = useAuth();
  return (
    <output data-testid="detail-owner-auth">
      {JSON.stringify([auth.mode, auth.user?.id, auth.user?.team_id, auth.capabilities.raw_prompt_view])}
    </output>
  );
}

async function setup() {
  const identity = { principal: "public-owner-a", team: "public-team-a", raw: true };
  const calls: string[] = [];
  function bootstrap(): UIBootstrap {
    return {
      backend_version: "v0.86.45",
      ui_version: "v0.86.45",
      api_version: "v1",
      capabilities: { raw_prompt_view: identity.raw },
      ui: {
        enabled: true,
        default_entry: "/app/overview",
        legacy_fallback: true,
        feedback_enabled: false,
        telemetry_enabled: false,
      },
      authentication: {
        enabled: true,
        authenticated: true,
        mode: "session",
        keycloak_enabled: false,
        allow_local_login: true,
        sso_login_url: "/auth/keycloak/login",
        credential_prefixes: ["vc_sk_", "vc_sa_"],
      },
      user: {
        id: identity.principal,
        email: "public-operator@example.invalid",
        role: "admin",
        roles: ["admin"],
        team_id: identity.team,
        scopes: ["admin:read", "admin:write"],
        features: {},
      },
      roles: ["admin"],
      permissions: ["admin:read", "admin:write"],
      allowed_features: ["observability.xview"],
      migration_registry: [],
      system_status: { status: "healthy" },
      legacy_route_map: {},
    };
  }
  const transport = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input), "http://public-test.invalid").pathname;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      if (method !== "GET") throw new Error(`Unexpected synthetic mutation: ${method} ${path}`);
      if (path === "/admin/ui-bootstrap") return json(bootstrap());
      if (path === "/admin/scatter")
        return json({
          points: [
            { request_id: requestId, created_at: "2026-10-08T08:59:30Z", latency_ms: 10, status_code: 200 },
          ],
          cursor: { ingested_at: "2026-10-08T08:59:59.000000000Z", request_id: requestId },
          server_time: "2026-10-08T09:00:00Z",
        });
      if (path === "/admin/xview/delta")
        return json({
          points: [],
          cursor: { ingested_at: "2026-10-08T08:59:59.000000000Z", request_id: requestId },
          has_more: false,
          server_time: "2026-10-08T09:00:00Z",
        });
      if (path === "/admin/saved-filters") return json({ filters: [] });
      const originalOwner =
        identity.raw && identity.principal === "public-owner-a" && identity.team === "public-team-a";
      if (path.endsWith("/explain"))
        return json({
          request_id: requestId,
          routing: { detail: originalOwner ? originalExplain : "PUBLIC-MASKED-EXPLAIN" },
        });
      if (path.endsWith("/trace"))
        return json({
          request_id: requestId,
          total_ms: 10,
          spans: [
            {
              span_id: "public-span",
              name: "public-span-name",
              kind: "request",
              status: "error",
              start_offset_ms: 0,
              duration_ms: 10,
              error: originalOwner ? originalTrace : "PUBLIC-MASKED-TRACE",
            },
          ],
        });
      if (path.endsWith("/links"))
        return json({ request_id: requestId, counts: {}, governance: { blocked: false } });
      if (path.endsWith("/note"))
        return json({
          request_id: requestId,
          note: "",
          tags: [],
          exists: false,
          redacted_fields: identity.raw ? [] : ["note"],
        });
      throw new Error(`Unexpected synthetic read: ${path}`);
    }),
    getAccessToken: () => "",
    getRefreshToken: () => "",
    getLegacyToken: () => "",
    getSessionEpoch: tokenStore.getSessionEpoch,
    saveTokens: vi.fn(),
    clearTokens: vi.fn(),
    notifyLogout: vi.fn(),
  });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  // Production cache policy: no test-only gcTime:0 or staleTime overrides.
  const client = createAppQueryClient();
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/observability/xview?window=5m"]}>
        <AuthProvider>
          <AuthProbe />
          <FeatureAccessHarness featureId="observability.xview">
            <XViewPage />
          </FeatureAccessHarness>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await advance(100);
  const reopen = async () => {
    const select = screen.queryByRole("button", { name: "최근 25건 선택" });
    if (select) await click(select);
    await click(screen.getByRole("button", { name: `${requestId} 원인 설명 열기` }));
  };
  const detailReads = () =>
    Object.fromEntries(
      ["explain", "trace", "links"].map((kind) => [
        kind,
        calls.filter((path) => path.endsWith(`/${kind}`)).length,
      ]),
    );
  await reopen();
  await click(screen.getByText("라우팅 판단 원문 보기"));
  expect(screen.getByText(originalExplain)).toBeVisible();
  expect(screen.getByText(originalTrace)).toBeVisible();
  expect(detailReads()).toEqual({ explain: 1, trace: 1, links: 1 });
  const epoch = tokenStore.getSessionEpoch();
  const changeOwner = async (change: "raw" | "principal" | "team") => {
    if (change === "raw") identity.raw = false;
    if (change === "principal") identity.principal = "public-owner-b";
    if (change === "team") identity.team = "public-team-b";
    // Actual AuthProvider runtime bootstrap refresh; no mocked useAuth or remount.
    fireEvent(document, new Event("visibilitychange"));
    await advance(100);
    expect(screen.getByTestId("detail-owner-auth")).toHaveTextContent(
      JSON.stringify(["authenticated", identity.principal, identity.team, identity.raw]),
    );
    expect(calls.filter((path) => path === "GET /admin/ui-bootstrap")).toHaveLength(2);
    expect(tokenStore.getSessionEpoch()).toBe(epoch);
    expect(screen.queryByRole("dialog", { name: "요청 원인 설명" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(originalExplain);
    expect(document.body).not.toHaveTextContent(originalTrace);
  };
  return { client, reopen, detailReads, changeOwner, epoch };
}

describe("independent XView detail read-owner cache boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T09:00:00Z"));
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    tokenStore.clearAll();
  });
  afterEach(() => {
    cleanup();
    for (const client of clients.splice(0)) client.clear();
    tokenStore.clearAll();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("positive control: an unchanged raw-authorized owner can reopen fresh cached details", async () => {
    const current = await setup();
    await click(
      within(screen.getByRole("dialog", { name: "요청 원인 설명" })).getByRole("button", {
        name: "패널 닫기",
      }),
    );
    expect(document.body).not.toHaveTextContent(originalExplain);
    await current.reopen();
    await click(screen.getByText("라우팅 판단 원문 보기"));
    expect(screen.getByText(originalExplain)).toBeVisible();
    expect(screen.getByText(originalTrace)).toBeVisible();
    expect(current.detailReads()).toEqual({ explain: 1, trace: 1, links: 1 });
    expect(tokenStore.getSessionEpoch()).toBe(current.epoch);
  });

  it("keeps request-prefix invalidation refetching the current owner's scoped explain, trace and links", async () => {
    const current = await setup();
    await act(async () => {
      await current.client.invalidateQueries({
        queryKey: ["observability", "requests", requestId],
      });
    });
    await advance();
    expect(current.detailReads()).toEqual({ explain: 2, trace: 2, links: 2 });
    expect(screen.getByText(originalExplain)).toBeVisible();
    expect(screen.getByText(originalTrace)).toBeVisible();
    expect(tokenStore.getSessionEpoch()).toBe(current.epoch);
  });

  it.each(["raw", "principal", "team"] as const)(
    "never reintroduces the previous owner's explain/trace originals after a same-session %s transition",
    async (change) => {
      const current = await setup();
      await current.changeOwner(change);
      await current.reopen();
      const disclosure = screen.queryByText("라우팅 판단 원문 보기");
      if (disclosure) await click(disclosure);
      const query = current.client
        .getQueryCache()
        .find({ queryKey: ["observability", "requests", requestId, "explain"] });
      const diagnostic = JSON.stringify({
        change,
        detailReads: current.detailReads(),
        sessionUnchanged: tokenStore.getSessionEpoch() === current.epoch,
        explainGC: query?.gcTime,
        explainDataAgeMs: query ? Date.now() - query.state.dataUpdatedAt : null,
      });
      expect.soft(document.body, diagnostic).not.toHaveTextContent(originalExplain);
      expect.soft(document.body, diagnostic).not.toHaveTextContent(originalTrace);
    },
  );
});
