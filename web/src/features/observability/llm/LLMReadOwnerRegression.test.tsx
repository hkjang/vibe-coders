import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "@/app/auth/AuthProvider";
import { createAppQueryClient } from "@/app/providers/query-client";
import { LLMPage } from "@/features/observability/llm/LLMPage";
import { ApiClient, apiClient } from "@/shared/api/client";
import type { UIBootstrap } from "@/shared/api/schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessHarness } from "@/test/feature-access";

const requestId = "public-llm-owner-request";
const promptName = "public-llm-owner-prompt";
const original = {
  parent: "PUBLIC-OLD-LLM-EVALUATION-REASON",
  detail: "PUBLIC-OLD-LLM-TRACE-PROMPT",
  explain: "PUBLIC-OLD-LLM-EXPLAIN-DETAIL",
  trace: "PUBLIC-OLD-LLM-SPAN-ERROR",
  links: "PUBLIC-OLD-LLM-LINK-SESSION",
  compare: "PUBLIC-OLD-LLM-COMPARE-REASON",
};
const detailPath = `/admin/llm/traces/${requestId}`;
const comparePath = "/admin/llm/prompts/compare";
const clients: QueryClient[] = [];
type OwnerChange = "raw" | "principal" | "team";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

function deferred() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!release) throw new Error("Synthetic deferred response was not initialized");
      release();
    },
  };
}

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
    <output data-testid="llm-owner-auth">
      {JSON.stringify([auth.mode, auth.user?.id, auth.user?.team_id, auth.capabilities.raw_prompt_view])}
    </output>
  );
}

async function setup({ tab = "evaluations", holdFirstPath }: { tab?: string; holdFirstPath?: string } = {}) {
  const identity = { principal: "public-owner-a", team: "public-team-a", raw: true, generation: 0 };
  const calls: Array<{ path: string; search: string; method: string }> = [];
  const held = deferred();
  let heldRequested = false;
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
      allowed_features: ["observability.llm"],
      migration_registry: [],
      system_status: { status: "healthy" },
      legacy_route_map: {},
    };
  }
  const value = (key: keyof typeof original) =>
    identity.generation === 0 ? original[key] : `PUBLIC-CURRENT-${key}-${identity.generation}`;
  function responseBody(path: string): unknown {
    if (path === "/admin/ui-bootstrap") return bootstrap();
    if (path === "/admin/llm/timeseries") return { points: [] };
    if (path === "/admin/llm/evaluations")
      return {
        summary: [{ name: "public-quality", total: 1, failed: 1 }],
        evaluations: [
          {
            id: "public-evaluation",
            request_id: requestId,
            trace_id: "public-trace",
            name: "public-quality",
            score: 0.2,
            label: "fail",
            passed: false,
            reason: value("parent"),
            created_at: "2026-10-08T08:59:30Z",
          },
        ],
      };
    if (path === "/admin/llm/feedback") return { feedback: [] };
    if (path === "/admin/llm/prompts")
      return { prompts: [{ prompt_name: promptName, prompt_version: "v2", calls: 1 }] };
    if (path === "/admin/llm/insights") return { insights: [] };
    if (path === "/admin/llm/patterns") return { patterns: [] };
    if (path === comparePath)
      return {
        prompt_name: promptName,
        candidate: { prompt_name: promptName, prompt_version: "v2", calls: 1 },
        baseline: { prompt_name: promptName, prompt_version: "v1", calls: 1 },
        baseline_reason: value("compare"),
        available_versions: ["v1", "v2"],
      };
    if (path === detailPath)
      return {
        request: {
          id: requestId,
          trace_id: "public-trace",
          prompt_name: value("detail"),
          prompt_version: "v2",
          status_code: 200,
          created_at: "2026-10-08T08:59:30Z",
        },
        spans: [],
        evaluations: [],
        feedback: [],
        tools: [],
      };
    if (path === `/admin/requests/${requestId}/explain`)
      return { request_id: requestId, routing: { detail: value("explain") } };
    if (path === `/admin/requests/${requestId}/trace`)
      return {
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
            error: value("trace"),
          },
        ],
      };
    if (path === `/admin/requests/${requestId}/links`)
      return {
        request_id: requestId,
        session_id: value("links"),
        counts: {},
        governance: { blocked: false },
      };
    if (path === `/admin/requests/${requestId}/note`)
      return {
        request_id: requestId,
        note: "",
        tags: [],
        created_by: "public-operator",
        updated_at: "2026-10-08T08:59:30Z",
        exists: false,
        redacted_fields: identity.raw ? [] : ["note"],
      };
    throw new Error(`Unexpected synthetic read path: ${path}`);
  }
  const transport = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input), "http://public-test.invalid");
      const method = init?.method ?? "GET";
      calls.push({ path: url.pathname, search: url.search, method });
      if (method !== "GET") throw new Error("Unexpected synthetic mutation");
      // Capture the response under the dispatching owner before any delay. The
      // synthetic server deliberately need not honor AbortSignal; client guards must.
      const body = responseBody(url.pathname);
      if (url.pathname === holdFirstPath && !heldRequested) {
        heldRequested = true;
        await held.promise;
      }
      return json(body);
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
    tab === "prompts" ? `${promptName} 버전 비교` : `${requestId} 호출 상세 열기`,
    tab,
    holdFirstPath === "/admin/llm/evaluations",
  );
  expect(screen.getByRole("heading", { name: "LLM 관측", level: 1 })).toBeVisible();
  const epoch = tokenStore.getSessionEpoch();
  const count = (path: string) => calls.filter((call) => call.path === path).length;
  const changeOwner = async (change: OwnerChange | "restore-a") => {
    if (change === "raw") identity.raw = false;
    if (change === "principal") identity.principal = "public-owner-b";
    if (change === "team") identity.team = "public-team-b";
    if (change === "restore-a")
      Object.assign(identity, { principal: "public-owner-a", team: "public-team-a", raw: true });
    identity.generation += 1;
    const bootstraps = count("/admin/ui-bootstrap");
    fireEvent(document, new Event("visibilitychange"));
    await advance(100);
    expect(count("/admin/ui-bootstrap")).toBe(bootstraps + 1);
    expect(screen.getByTestId("llm-owner-auth")).toHaveTextContent(
      JSON.stringify(["authenticated", identity.principal, identity.team, identity.raw]),
    );
    expect(tokenStore.getSessionEpoch()).toBe(epoch);
  };
  const cache = () =>
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    );
  const release = async () => {
    expect(heldRequested).toBe(true);
    await act(async () => held.resolve());
    await advance(100);
  };
  return { client, count, changeOwner, cache, release, calls, epoch };
}

async function openDetail() {
  await click(screen.getByRole("button", { name: `${requestId} 호출 상세 열기` }));
}

async function closeDetailIfOpen() {
  const dialog = screen.queryByRole("dialog", { name: "LLM 호출 상세" });
  if (dialog) await click(within(dialog).getByRole("button", { name: "패널 닫기" }));
}

async function openExplanation() {
  await click(screen.getByRole("button", { name: "원인 설명 열기" }));
  await click(screen.getByText("라우팅 판단 원문 보기"));
}

async function openCompare() {
  await click(screen.getByRole("button", { name: `${promptName} 버전 비교` }));
}

async function closeCompareIfOpen() {
  const dialog = screen.queryByRole("dialog", { name: "프롬프트 버전 비교" });
  if (dialog) await click(within(dialog).getByRole("button", { name: "닫기" }));
}

function expectRetired(current: Awaited<ReturnType<typeof setup>>, ...keys: Array<keyof typeof original>) {
  for (const key of keys) {
    expect
      .soft(document.body, `${key}: no previous-owner text in visible or hidden DOM`)
      .not.toHaveTextContent(original[key]);
    expect
      .soft(current.cache(), `${key}: no previous-owner response left in QueryCache`)
      .not.toContain(original[key]);
  }
}

describe("independent LLM read-owner isolation with actual auth and production cache", () => {
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

  it("positive: same-owner fresh trace and lazy explanation reopen without extra reads", async () => {
    const current = await setup();
    await openDetail();
    expect(screen.getByText(`${original.detail} v2`)).toBeVisible();
    await openExplanation();
    expect(screen.getByText(original.explain)).toBeVisible();
    expect(screen.getByText(original.trace)).toBeVisible();
    expect(screen.getByRole("link", { name: "세션 흐름 보기" })).toHaveAttribute(
      "href",
      expect.stringContaining(original.links),
    );
    expect(screen.getByText("저장된 메모·태그가 없습니다.")).toBeVisible();
    await closeDetailIfOpen();
    await openDetail();
    await openExplanation();
    expect(screen.getByText(original.explain)).toBeVisible();
    expect(screen.getByText(original.trace)).toBeVisible();
    for (const path of [
      detailPath,
      `/admin/requests/${requestId}/explain`,
      `/admin/requests/${requestId}/trace`,
      `/admin/requests/${requestId}/links`,
    ])
      expect(current.count(path)).toBe(1);
    expect(current.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("positive: same-owner prompt comparison reopens its fresh cache", async () => {
    const current = await setup({ tab: "prompts" });
    await openCompare();
    expect(screen.getByText(original.compare)).toBeVisible();
    await closeCompareIfOpen();
    await openCompare();
    expect(screen.getByText(original.compare)).toBeVisible();
    expect(current.count(comparePath)).toBe(1);
  });

  it("positive: an ordinary filter then parent refetch preserves a same-owner selected detail and note section", async () => {
    const current = await setup();
    fireEvent.change(screen.getByRole("textbox", { name: "모델" }), { target: { value: "public-model" } });
    await click(screen.getByRole("button", { name: "적용" }));
    expect(
      current.calls.some(
        (call) =>
          call.path === "/admin/llm/evaluations" &&
          new URLSearchParams(call.search).get("model") === "public-model",
      ),
    ).toBe(true);
    await openDetail();
    await openExplanation();
    await act(async () => {
      await current.client.invalidateQueries({ queryKey: ["observability", "llm"] });
    });
    await advance();
    expect(screen.getByRole("dialog", { name: "LLM 호출 상세" })).toBeVisible();
    expect(screen.getByText(`${original.detail} v2`)).toBeVisible();
    expect(screen.getByText("저장된 메모·태그가 없습니다.")).toBeVisible();
    expect(tokenStore.getSessionEpoch()).toBe(current.epoch);
    expect(current.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it.each(["raw", "principal", "team"] as const)(
    "retires the parent evaluation list after same-epoch %s change",
    async (change) => {
      const current = await setup();
      expect(screen.getByText(original.parent)).toBeVisible();
      await current.changeOwner(change);
      expectRetired(current, "parent");
    },
  );

  it.each(["raw", "principal", "team"] as const)(
    "retires selected trace metadata and its cached reopen after same-epoch %s change",
    async (change) => {
      const current = await setup();
      await openDetail();
      expect(screen.getByText(`${original.detail} v2`)).toBeVisible();
      await current.changeOwner(change);
      expect.soft(screen.queryByRole("dialog", { name: "LLM 호출 상세" })).not.toBeInTheDocument();
      expectRetired(current, "detail");
      await closeDetailIfOpen();
      await waitForReadControl(current.client, "evaluations", `${requestId} 호출 상세 열기`);
      await openDetail();
      expectRetired(current, "detail");
    },
  );

  it.each(["raw", "principal", "team"] as const)(
    "retires lazy shared explain/trace/links after same-epoch %s change",
    async (change) => {
      const current = await setup();
      await openDetail();
      await openExplanation();
      expect(screen.getByText(original.explain)).toBeVisible();
      expect(screen.getByText(original.trace)).toBeVisible();
      expect(screen.getByRole("link", { name: "세션 흐름 보기" })).toHaveAttribute(
        "href",
        expect.stringContaining(original.links),
      );
      await current.changeOwner(change);
      expectRetired(current, "explain", "trace", "links");
      expect.soft(document.body.innerHTML).not.toContain(original.links);
      await closeDetailIfOpen();
      await waitForReadControl(current.client, "evaluations", `${requestId} 호출 상세 열기`);
      await openDetail();
      await openExplanation();
      expectRetired(current, "explain", "trace", "links");
      expect.soft(document.body.innerHTML).not.toContain(original.links);
    },
  );

  it.each(["raw", "principal", "team"] as const)(
    "retires prompt comparison and its cached reopen after same-epoch %s change",
    async (change) => {
      const current = await setup({ tab: "prompts" });
      await openCompare();
      expect(screen.getByText(original.compare)).toBeVisible();
      await current.changeOwner(change);
      expect.soft(screen.queryByRole("dialog", { name: "프롬프트 버전 비교" })).not.toBeInTheDocument();
      expectRetired(current, "compare");
      await closeCompareIfOpen();
      await waitForReadControl(current.client, "prompts", `${promptName} 버전 비교`);
      await openCompare();
      expectRetired(current, "compare");
    },
  );

  it("does not revive the old trace cache after same-epoch owner A to B to A", async () => {
    const current = await setup();
    await openDetail();
    expect(screen.getByText(`${original.detail} v2`)).toBeVisible();
    await closeDetailIfOpen();
    await current.changeOwner("principal");
    await current.changeOwner("restore-a");
    await openDetail();
    expectRetired(current, "detail");
  });

  it("does not publish a late parent list dispatched for the previous team", async () => {
    const current = await setup({ holdFirstPath: "/admin/llm/evaluations" });
    expect(current.count("/admin/llm/evaluations")).toBe(1);
    await current.changeOwner("team");
    await current.release();
    expectRetired(current, "parent");
  });

  it("does not publish a late selected trace dispatched for the previous principal", async () => {
    const current = await setup({ holdFirstPath: detailPath });
    await openDetail();
    expect(screen.getByText("호출 상세를 불러오는 중입니다.")).toBeVisible();
    expect(current.count(detailPath)).toBe(1);
    await current.changeOwner("principal");
    await current.release();
    expect.soft(screen.queryByRole("dialog", { name: "LLM 호출 상세" })).not.toBeInTheDocument();
    expectRetired(current, "detail");
  });
});
