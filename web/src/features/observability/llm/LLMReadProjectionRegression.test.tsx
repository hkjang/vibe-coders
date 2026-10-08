import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "@/app/auth/AuthProvider";
import { createAppQueryClient } from "@/app/providers/query-client";
import { LLMPage } from "./LLMPage";
import { ApiClient, apiClient } from "@/shared/api/client";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import type { UIBootstrap } from "@/shared/api/schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessHarness } from "@/test/feature-access";

const requestA = "public-team-a-request";
const requestB = "public-team-b-request";
const promptName = "public-shared-prompt";
const noteA = "Public team A shared note";
const rowA = "Public team A evaluation";
const rowB = "Public team B evaluation";
const pii = {
  parent: "public-parent@example.invalid",
  detail: "public-detail@example.invalid",
  explain: "public-explain@example.invalid",
  trace: "public-trace@example.invalid",
  note: "public-note@example.invalid",
};
const clients: QueryClient[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
async function advance(milliseconds = 25) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}

// Wait for initial auth/Query observer commits, not a longer fixed timer delay.
// The bounded 20 x 5 ms budget is the same 100 ms as the original setup.
async function waitForInitialRead(
  client: QueryClient,
  buttonName: string,
  tab: string,
  heldEvaluations = false,
) {
  const kinds = ["timeseries", "evaluations", "feedback", ...(tab === "prompts" ? ["prompts"] : [])];
  for (let turn = 0; turn < 20; turn += 1) {
    await advance(5);
    const ready = kinds.every((kind) => {
      const query = client
        .getQueryCache()
        .getAll()
        .find(
          (item) =>
            item.queryKey[0] === "observability" && item.queryKey[1] === "llm" && item.queryKey[2] === kind,
        );
      if (heldEvaluations && kind === "evaluations")
        return query?.state.status === "pending" && query.state.fetchStatus === "fetching";
      return query?.state.status === "success" && query.state.fetchStatus === "idle";
    });
    const rendered = heldEvaluations
      ? screen.queryByRole("heading", { name: "최근 평가" })
      : screen.queryByRole("button", { name: buttonName });
    if (ready && rendered) return;
  }
  throw new Error("Initial LLM Query results and visible controls were not ready within 100 ms");
}

async function click(element: HTMLElement) {
  fireEvent.click(element);
  await advance();
}

// Called only after the original, immediate retirement assertions have run.
// Flush pending observer notifications without advancing the security clock.
async function waitForReadControl(client: QueryClient, kind: string, name: string) {
  for (let turn = 0; turn < 20; turn += 1) {
    const query = client
      .getQueryCache()
      .getAll()
      .find(
        (item) =>
          item.queryKey[0] === "observability" && item.queryKey[1] === "llm" && item.queryKey[2] === kind,
      );
    if (
      query?.state.status === "success" &&
      query.state.fetchStatus === "idle" &&
      screen.queryByRole("button", { name })
    )
      return;
    await advance(0);
  }
  // Preserve the original strict/soft control assertion even if readiness never arrives.
}
function AuthProbe(): React.JSX.Element {
  const auth = useAuth();
  return (
    <output data-testid="llm-projection-auth">
      {JSON.stringify([
        auth.user?.id,
        auth.user?.role,
        auth.user?.team_id,
        auth.capabilities.raw_prompt_view,
      ])}
    </output>
  );
}

// Contract-derived synthetic HTTP projections, not a Go-server execution:
// admin_roles.go:20-36,79,188,213; provider_external_projection.go:301;
// request_note_app.go:84-97; admin_request_readability.go:100-154;
// queries.go:1878-1890,2023. Each example.invalid email is an audit.Redact target.
async function setup({ mode = "raw", tab = "evaluations" }: { mode?: "raw" | "team"; tab?: string } = {}) {
  const server = {
    role: mode === "raw" ? "admin" : "team_admin",
    team: "public-team-a",
    expireBootstrap: false,
    revision: 0,
  };
  const calls: Array<{ method: string; path: string; status: number }> = [];
  const raw = () => server.role === "admin";
  const teamB = () => mode === "team" && server.team === "public-team-b";
  const requestId = () => (teamB() ? requestB : requestA);
  const redact = (value: string) => (raw() ? value : "[REDACTED_EMAIL]");
  const scopes = () => (raw() ? ["admin:read", "admin:write"] : ["admin:read"]);
  function bootstrap(): UIBootstrap {
    return {
      backend_version: "v0.86.45",
      ui_version: "v0.86.45",
      api_version: "v1",
      capabilities: { raw_prompt_view: raw() },
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
        id: "public-same-subject",
        email: "public-operator@example.invalid",
        role: server.role,
        roles: [server.role],
        team_id: server.team,
        scopes: scopes(),
        features: {},
      },
      roles: [server.role],
      permissions: scopes(),
      allowed_features: ["observability.llm"],
      migration_registry: [],
      system_status: { status: "healthy" },
      legacy_route_map: {},
    };
  }
  const candidate = () => ({ prompt_name: promptName, prompt_version: "v2", calls: teamB() ? 3 : 17 });
  const transport = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input), "http://public-test.invalid").pathname;
      const method = init?.method ?? "GET";
      const reply = (body: unknown, status = 200) => {
        calls.push({ method, path, status });
        return json(body, status);
      };
      if (method === "POST" && path === "/auth/refresh")
        return reply({
          access_token: `public-projection-access-${server.revision}`,
          refresh_token: `public-projection-refresh-${server.revision}`,
          token_type: "Bearer",
          expires_in: 300,
          refresh_expires_in: 600,
        });
      if (method !== "GET") throw new Error("No business mutation is permitted in this fixture");
      if (path === "/admin/ui-bootstrap") {
        if (server.expireBootstrap) {
          server.expireBootstrap = false;
          return reply({ error: { message: "Synthetic expired access", type: "authentication_error" } }, 401);
        }
        return reply(bootstrap());
      }
      if (
        teamB() &&
        (path === `/admin/llm/traces/${requestA}` || path.startsWith(`/admin/requests/${requestA}/`))
      )
        return reply(
          {
            error: {
              message: "request is outside your team scope",
              type: "permission_error",
              code: "cross_team_access_denied",
            },
          },
          403,
        );
      if (path === "/admin/llm/timeseries") return reply({ points: [] });
      if (path === "/admin/llm/evaluations")
        return reply({
          evaluations: [
            {
              id: `public-evaluation-${requestId()}`,
              request_id: requestId(),
              reason: mode === "raw" ? redact(pii.parent) : teamB() ? rowB : rowA,
              name: "public-quality",
              created_at: "2026-10-08T08:59:30Z",
            },
          ],
        });
      if (path === "/admin/llm/feedback") return reply({ feedback: [] });
      if (path === "/admin/llm/prompts") return reply({ prompts: [candidate()] });
      if (path === "/admin/llm/insights") return reply({ insights: [] });
      if (path === "/admin/llm/patterns") return reply({ patterns: [] });
      if (path === "/admin/llm/prompts/compare")
        return reply({
          prompt_name: promptName,
          candidate: candidate(),
          baseline: { prompt_name: promptName, prompt_version: "v1", calls: 2 },
          baseline_reason: "nearest_previous_version",
          available_versions: ["v1", "v2"],
          delta: { calls: (teamB() ? 3 : 17) - 2 },
        });
      if (path === `/admin/llm/traces/${requestId()}`)
        return reply({
          request: {
            id: requestId(),
            prompt_name: mode === "raw" ? redact(pii.detail) : promptName,
            prompt_version: "v2",
            status_code: 200,
          },
          spans: [],
          evaluations: [],
          feedback: [],
          tools: [],
        });
      if (path === `/admin/requests/${requestId()}/explain`)
        return reply({
          request_id: requestId(),
          routing: { detail: mode === "raw" ? redact(pii.explain) : `Public explanation ${requestId()}` },
        });
      if (path === `/admin/requests/${requestId()}/trace`)
        return reply({
          request_id: requestId(),
          spans: [
            {
              span_id: "public-span",
              name: "public-span",
              kind: "request",
              status: "error",
              error: mode === "raw" ? redact(pii.trace) : "Public team trace error",
            },
          ],
        });
      if (path === `/admin/requests/${requestId()}/links`)
        return reply({ request_id: requestId(), counts: {}, governance: { blocked: false } });
      if (path === `/admin/requests/${requestId()}/note`)
        return reply({
          request_id: requestId(),
          note: mode === "raw" ? redact(pii.note) : teamB() ? "Public team B shared note" : noteA,
          tags: ["public-tag"],
          created_by: "public-operator",
          updated_at: "2026-10-08T08:59:30Z",
          exists: true,
          redacted_fields: mode === "raw" && !raw() ? ["note"] : [],
        });
      throw new Error(`Unexpected synthetic read path: ${path}`);
    }),
    getAccessToken: tokenStore.getAccessToken,
    getRefreshToken: tokenStore.getRefreshToken,
    getLegacyToken: tokenStore.getLegacyToken,
    getSessionEpoch: tokenStore.getSessionEpoch,
    saveTokens: tokenStore.refreshTokens,
    clearTokens: tokenStore.clearTokens,
    notifyLogout: vi.fn(),
  });
  tokenStore.saveTokens({
    access_token: "public-projection-access-0",
    refresh_token: "public-projection-refresh-0",
  });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  const client = createAppQueryClient();
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/observability/llm?tab=${tab}`]}>
        <AuthProvider>
          <AuthProbe />
          <FeatureAccessHarness featureId="observability.llm">
            <LLMPage />
          </FeatureAccessHarness>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitForInitialRead(
    client,
    tab === "prompts" ? `${promptName} 버전 비교` : `${requestA} 호출 상세 열기`,
    tab,
  );
  const epoch = tokenStore.getSessionEpoch();
  const rotate = async (transition: "same-owner" | "role-down" | "team-b") => {
    const previousAccess = tokenStore.getAccessToken();
    if (transition === "role-down") server.role = "readonly_admin";
    if (transition === "team-b") server.team = "public-team-b";
    server.revision += 1;
    server.expireBootstrap = true;
    fireEvent(document, new Event("visibilitychange"));
    await advance(100);
    expect(calls.filter((call) => call.method === "POST" && call.path === "/auth/refresh")).toHaveLength(
      server.revision,
    );
    expect(tokenStore.getAccessToken()).not.toBe(previousAccess);
    expect(tokenStore.getSessionEpoch()).toBe(epoch);
    expect(screen.getByTestId("llm-projection-auth")).toHaveTextContent(
      JSON.stringify(["public-same-subject", server.role, server.team, raw()]),
    );
  };
  const cache = () =>
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    );
  return { client, transport, calls, rotate, cache };
}

async function openDetail() {
  await click(screen.getByRole("button", { name: `${requestA} 호출 상세 열기` }));
  await click(screen.getByRole("button", { name: "원인 설명 열기" }));
  await click(screen.getByText("라우팅 판단 원문 보기"));
}

describe("independent LLM contract-derived read projections", () => {
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

  it("positive: normal access-token refresh preserves the same owner's opened raw detail and note", async () => {
    const current = await setup();
    await openDetail();
    expect(screen.getByText(pii.explain)).toBeVisible();
    expect(screen.getByText(`메모: ${pii.note}`)).toBeVisible();
    await current.rotate("same-owner");
    expect(screen.getByRole("dialog", { name: "LLM 호출 상세" })).toBeVisible();
    expect(screen.getByText(pii.explain)).toBeVisible();
    expect(screen.getByText(`메모: ${pii.note}`)).toBeVisible();
    expect(current.calls.filter((call) => call.path === `/admin/llm/traces/${requestA}`)).toHaveLength(1);
  });

  it("retires real redaction targets after same-subject admin to readonly_admin token refresh", async () => {
    const current = await setup();
    expect(screen.getByText(pii.parent)).toBeVisible();
    await openDetail();
    expect(screen.getByText(`${pii.detail} v2`)).toBeVisible();
    expect(screen.getByText(pii.explain)).toBeVisible();
    expect(screen.getByText(pii.trace)).toBeVisible();
    expect(screen.getByText(`메모: ${pii.note}`)).toBeVisible();
    await current.rotate("role-down");
    // Independent transport probes confirm what a current-role fresh read returns;
    // they do not write the QueryCache or repair the component under test.
    const evaluations = await current.transport.request(endpoints.domains.observability.llm.evaluations);
    expect(evaluations.evaluations[0]?.reason).toBe("[REDACTED_EMAIL]");
    const detail = await current.transport.request(
      withPathParams(endpoints.domains.observability.llm.traceDetail, { id: requestA }),
    );
    expect(detail.request.prompt_name).toBe("[REDACTED_EMAIL]");
    const explain = await current.transport.request(
      withPathParams(endpoints.domains.observability.requests.explain, { id: requestA }),
    );
    expect(explain.routing.detail).toBe("[REDACTED_EMAIL]");
    const note = await current.transport.request(
      withPathParams(endpoints.domains.observability.requests.note, { id: requestA }),
    );
    expect(note.note).toBe("[REDACTED_EMAIL]");
    expect(note.redacted_fields).toEqual(["note"]);
    expect(note.tags).toEqual(["public-tag"]);
    expect.soft(screen.queryByRole("dialog", { name: "LLM 호출 상세" })).not.toBeInTheDocument();
    for (const marker of Object.values(pii)) {
      expect.soft(document.body).not.toHaveTextContent(marker);
      expect.soft(current.cache()).not.toContain(marker);
    }
  });

  it("retires team A detail when same-subject team_admin refresh moves to team B and fresh old-request reads return 403", async () => {
    const current = await setup({ mode: "team" });
    expect(screen.getByText(rowA)).toBeVisible();
    await openDetail();
    expect(screen.getByText(`메모: ${noteA}`)).toBeVisible();
    await current.rotate("team-b");
    for (const endpoint of [
      withPathParams(endpoints.domains.observability.llm.traceDetail, { id: requestA }),
      withPathParams(endpoints.domains.observability.requests.explain, { id: requestA }),
      withPathParams(endpoints.domains.observability.requests.note, { id: requestA }),
    ])
      await expect(current.transport.request(endpoint)).rejects.toMatchObject({ status: 403 });
    const evaluations = await current.transport.request(endpoints.domains.observability.llm.evaluations);
    expect(evaluations.evaluations.map((item) => item.request_id)).toEqual([requestB]);
    expect.soft(screen.queryByRole("dialog", { name: "LLM 호출 상세" })).not.toBeInTheDocument();
    for (const marker of [requestA, rowA, noteA]) {
      expect.soft(document.body).not.toHaveTextContent(marker);
      expect.soft(current.cache()).not.toContain(marker);
    }
    await waitForReadControl(current.client, "evaluations", `${requestB} 호출 상세 열기`);
    expect.soft(screen.queryByRole("button", { name: `${requestB} 호출 상세 열기` })).toBeVisible();
  });

  it("retires prior-team prompt counts while keeping the known prompt name and algorithmic baseline reason ordinary", async () => {
    const current = await setup({ mode: "team", tab: "prompts" });
    await click(screen.getByRole("button", { name: `${promptName} 버전 비교` }));
    let dialog = screen.getByRole("dialog", { name: "프롬프트 버전 비교" });
    expect(within(within(dialog).getByRole("row", { name: /^호출 / })).getByText("17")).toBeVisible();
    expect(within(dialog).getByText("nearest_previous_version")).toBeVisible();
    await current.rotate("team-b");
    const comparison = await current.transport.request(endpoints.domains.observability.llm.promptCompare, {
      query: { prompt_name: promptName, candidate: "v2" },
    });
    expect(comparison.prompt_name).toBe(promptName);
    expect(comparison.baseline_reason).toBe("nearest_previous_version");
    expect(comparison.candidate.calls).toBe(3);
    expect.soft(screen.queryByRole("dialog", { name: "프롬프트 버전 비교" })).not.toBeInTheDocument();
    const cache = current.client
      .getQueryCache()
      .findAll({ queryKey: ["observability", "llm", "prompt-compare"] })
      .map((query) => query.state.data);
    expect
      .soft(cache)
      .not.toContainEqual(expect.objectContaining({ candidate: expect.objectContaining({ calls: 17 }) }));
    const old = screen.queryByRole("dialog", { name: "프롬프트 버전 비교" });
    if (old) await click(within(old).getByRole("button", { name: "닫기" }));
    await waitForReadControl(current.client, "prompts", `${promptName} 버전 비교`);
    await click(screen.getByRole("button", { name: `${promptName} 버전 비교` }));
    dialog = screen.getByRole("dialog", { name: "프롬프트 버전 비교" });
    expect.soft(within(within(dialog).getByRole("row", { name: /^호출 / })).queryByText("3")).toBeVisible();
  });
});
