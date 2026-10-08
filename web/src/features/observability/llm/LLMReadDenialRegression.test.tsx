import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "@/app/auth/AuthProvider";
import { createAppQueryClient } from "@/app/providers/query-client";
import { ApiClient, apiClient } from "@/shared/api/client";
import type { UIBootstrap } from "@/shared/api/schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessHarness } from "@/test/feature-access";
import { LLMPage } from "./LLMPage";

const requestId = "public-boundary-request";
const detailPath = `/admin/llm/traces/${requestId}`;
const notePath = `/admin/requests/${requestId}/note`;
const explainPath = `/admin/requests/${requestId}/explain`;
const feedbackPath = "/admin/llm/feedback";
const old = {
  detail: "PUBLIC-TEAM-DETAIL",
  explain: "PUBLIC-TEAM-EXPLANATION",
  span: "PUBLIC-TEAM-SPAN",
  note: "PUBLIC-TEAM-NOTE",
};
const late = "PUBLIC-LATE-TEAM-EXPLANATION";
const fresh = "PUBLIC-EXPLICIT-RECOVERED-DETAIL";
const draft = "PUBLIC-OPERATOR-DRAFT";
const clients: QueryClient[] = [];
type Kind = "note" | "feedback";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function advance(milliseconds = 25) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}
// Flush initial auth/query observer commits conditionally within the original
// 100 ms setup budget. Never use this helper after a security transition.
async function waitForInitialRead(client: QueryClient, kind: Kind) {
  for (let turn = 0; turn < 20; turn += 1) {
    await advance(5);
    const ready = ["timeseries", "evaluations", "feedback"].every((queryKind) => {
      const query = client
        .getQueryCache()
        .getAll()
        .find(
          (item) =>
            item.queryKey[0] === "observability" &&
            item.queryKey[1] === "llm" &&
            item.queryKey[2] === queryKind,
        );
      return query?.state.status === "success" && query.state.fetchStatus === "idle";
    });
    const trigger = screen.queryByRole("button", {
      name: kind === "note" ? `${requestId} 호출 상세 열기` : "피드백 남기기",
    });
    if (ready && trigger) return;
  }
  throw new Error("Initial LLM queries and first action were not ready within 100 ms");
}
async function click(element: HTMLElement) {
  fireEvent.click(element);
  await advance();
}
function AuthProbe(): React.JSX.Element {
  const auth = useAuth();
  return (
    <output data-testid="boundary-auth">
      {JSON.stringify([
        auth.user?.id,
        auth.user?.role,
        auth.user?.team_id,
        auth.capabilities.raw_prompt_view,
      ])}
      <span data-testid="boundary-write">{String(auth.user?.scopes.includes("admin:write"))}</span>
    </output>
  );
}
function RuntimeFeature(): React.JSX.Element {
  const [readOnly, setReadOnly] = useState(false);
  return (
    <FeatureAccessHarness featureId="observability.llm" readOnly={readOnly}>
      <button onClick={() => setReadOnly((value) => !value)}>테스트 읽기 전용 전환</button>
      <LLMPage />
    </FeatureAccessHarness>
  );
}

// No real server/credentials are used. A team_admin request can become inaccessible
// after API-key team reassignment without changing its bootstrap owner. Only detail
// resources return cross_team_access_denied; parent collections never fake that 403.
// The writer is a declared custom admin:read/admin:write role, always raw=false.
async function setup({ teamReader = false, kind = "note" }: { teamReader?: boolean; kind?: Kind } = {}) {
  const state = {
    write: !teamReader,
    detailStatus: 200,
    parentStatus: 200,
    recovered: false,
    expireBootstrap: false,
    revision: 0,
  };
  const calls: Array<{ path: string; method: string; body: unknown; status?: number }> = [];
  let holdExplanation = false;
  let releaseExplanation: (() => void) | undefined;
  const role = teamReader ? "team_admin" : "public_llm_operator";
  const owner = ["public-same-subject", role, "public-team-a", false];
  const scopes = () => ["admin:read", ...(state.write ? ["admin:write"] : [])];
  function bootstrap(): UIBootstrap {
    return {
      backend_version: "v0.86.45",
      ui_version: "v0.86.45",
      api_version: "v1",
      capabilities: { raw_prompt_view: false },
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
        role,
        roles: [role],
        team_id: "public-team-a",
        scopes: scopes(),
        features: {},
      },
      roles: [role],
      permissions: scopes(),
      allowed_features: ["observability.llm"],
      migration_registry: [],
      system_status: { status: "healthy" },
      legacy_route_map: {},
    };
  }
  const note = () => ({
    request_id: requestId,
    note: state.recovered ? "Public recovered note" : old.note,
    tags: ["public-tag"],
    created_by: "public-operator",
    updated_at: "2026-10-08T08:59:30Z",
    exists: true,
    redacted_fields: [],
  });
  const transport = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input), "http://public-test.invalid").pathname;
      const method = init?.method ?? "GET";
      const call = {
        path,
        method,
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
        status: undefined as number | undefined,
      };
      calls.push(call); // Record every attempt before responding; no write-permission mock guard.
      const reply = (body: unknown, status = 200) => {
        call.status = status;
        return json(body, status);
      };
      if (method === "POST" && path === "/auth/refresh")
        return reply({
          access_token: `public-access-${state.revision}`,
          refresh_token: `public-refresh-${state.revision}`,
          token_type: "Bearer",
          expires_in: 300,
          refresh_expires_in: 600,
        });
      if (method === "PATCH" && path === notePath) return reply(note());
      if (method === "POST" && path === feedbackPath)
        return reply({ feedback: { id: "public-feedback", request_id: requestId, rating: 1 } }, 201);
      if (method !== "GET") throw new Error(`Unexpected recorded synthetic method: ${method}`);
      if (path === "/admin/ui-bootstrap") {
        if (state.expireBootstrap) {
          state.expireBootstrap = false;
          return reply(
            {
              error: {
                message: "invalid access token",
                type: "authentication_error",
                code: "invalid_access_token",
              },
            },
            401,
          );
        }
        return reply(bootstrap());
      }
      if (path === explainPath && holdExplanation) {
        holdExplanation = false;
        const body = { request_id: requestId, routing: { detail: late } };
        await new Promise<void>((resolve) => {
          releaseExplanation = resolve;
        });
        return reply(body); // A response captured before denial may ignore AbortSignal.
      }
      if (
        (path === detailPath || path.startsWith(`/admin/requests/${requestId}/`)) &&
        state.detailStatus !== 200
      )
        return reply(
          {
            error: {
              message:
                state.detailStatus === 403
                  ? "request is outside your team scope"
                  : "Synthetic detail unavailable",
              type: state.detailStatus === 403 ? "permission_error" : "server_error",
              code: state.detailStatus === 403 ? "cross_team_access_denied" : "detail_failed",
            },
          },
          state.detailStatus,
        );
      if (path === "/admin/llm/evaluations") {
        if (state.parentStatus === 503)
          return reply(
            {
              error: {
                message: "Synthetic evaluations unavailable",
                type: "server_error",
                code: "llm_evaluations_failed",
              },
            },
            503,
          );
        return reply({
          evaluations: [
            {
              id: "public-evaluation",
              request_id: requestId,
              name: "public-quality",
              reason: "Public parent row",
              created_at: "2026-10-08T08:59:30Z",
            },
          ],
        });
      }
      if (path === "/admin/llm/timeseries") return reply({ points: [] });
      if (path === feedbackPath) return reply({ feedback: [] });
      if (path === "/admin/llm/prompts") return reply({ prompts: [] });
      if (path === "/admin/llm/insights") return reply({ insights: [] });
      if (path === "/admin/llm/patterns") return reply({ patterns: [] });
      if (path === detailPath)
        return reply({
          request: {
            id: requestId,
            prompt_name: state.recovered ? fresh : old.detail,
            prompt_version: "v2",
            status_code: 200,
          },
          spans: [],
          evaluations: [],
          feedback: [],
          tools: [],
        });
      if (path === explainPath)
        return reply({
          request_id: requestId,
          routing: { detail: state.recovered ? "Public recovered explanation" : old.explain },
        });
      if (path === `/admin/requests/${requestId}/trace`)
        return reply({
          request_id: requestId,
          spans: [
            {
              span_id: "public-span",
              name: "public-span",
              kind: "request",
              status: "error",
              error: state.recovered ? "Public recovered span" : old.span,
            },
          ],
        });
      if (path === `/admin/requests/${requestId}/links`)
        return reply({ request_id: requestId, counts: {}, governance: { blocked: false } });
      if (path === notePath) return reply(note());
      throw new Error(`Unexpected recorded synthetic path: ${path}`);
    }),
    getAccessToken: tokenStore.getAccessToken,
    getRefreshToken: tokenStore.getRefreshToken,
    getLegacyToken: tokenStore.getLegacyToken,
    getSessionEpoch: tokenStore.getSessionEpoch,
    saveTokens: tokenStore.refreshTokens,
    clearTokens: tokenStore.clearTokens,
    notifyLogout: vi.fn(),
  });
  tokenStore.saveTokens({ access_token: "public-access-0", refresh_token: "public-refresh-0" });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  const client = createAppQueryClient();
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[`/observability/llm?tab=${kind === "feedback" ? "feedback" : "evaluations"}`]}
      >
        <AuthProvider>
          <AuthProbe />
          <RuntimeFeature />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitForInitialRead(client, kind);
  const epoch = tokenStore.getSessionEpoch();
  const assertOwner = () => {
    expect(screen.getByTestId("boundary-auth")).toHaveTextContent(JSON.stringify(owner));
    expect(tokenStore.getSessionEpoch()).toBe(epoch);
  };
  assertOwner();
  const refetch = async (queryKey: readonly unknown[], milliseconds = 100) => {
    act(() => {
      void client.invalidateQueries({ queryKey });
    });
    await advance(milliseconds);
  };
  const setWrite = async (write: boolean) => {
    state.write = write;
    state.revision += 1;
    state.expireBootstrap = true;
    fireEvent(document, new Event("visibilitychange"));
    await advance(100);
    expect(calls.filter((call) => call.path === "/auth/refresh")).toHaveLength(state.revision);
    expect(screen.getByTestId("boundary-write")).toHaveTextContent(String(write));
    assertOwner();
  };
  const writes = () =>
    calls.filter(
      (call) =>
        (call.method === "PATCH" && call.path === notePath) ||
        (call.method === "POST" && call.path === feedbackPath),
    );
  const cache = () =>
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    );
  return {
    state,
    calls,
    client,
    cache,
    refetch,
    setWrite,
    writes,
    assertOwner,
    hold: () => {
      holdExplanation = true;
    },
    release: async () => {
      expect(releaseExplanation).toBeDefined();
      await act(async () => releaseExplanation?.());
      await advance(100);
    },
  };
}

async function openDetail() {
  await click(screen.getByRole("button", { name: `${requestId} 호출 상세 열기` }));
  await click(screen.getByRole("button", { name: "원인 설명 열기" }));
  await click(screen.getByText("라우팅 판단 원문 보기"));
  expect(screen.getByText(`메모: ${old.note}`)).toBeVisible();
}
async function openDraft(kind: Kind) {
  if (kind === "note") {
    await openDetail();
    await click(screen.getByRole("button", { name: "메모·태그 수정" }));
    fireEvent.change(screen.getByRole("combobox", { name: "메모 변경 방법" }), {
      target: { value: "replace" },
    });
    await advance();
    fireEvent.change(screen.getByRole("textbox", { name: "새 메모" }), { target: { value: draft } });
  } else {
    await click(screen.getByRole("button", { name: "피드백 남기기" }));
    fireEvent.change(screen.getByRole("textbox", { name: "요청 ID" }), { target: { value: requestId } });
    fireEvent.change(screen.getByRole("textbox", { name: "의견" }), { target: { value: draft } });
  }
  await advance();
}
function expectRetired(current: Awaited<ReturnType<typeof setup>>) {
  expect.soft(screen.queryByRole("dialog", { name: "LLM 호출 상세" })).not.toBeInTheDocument();
  for (const marker of [...Object.values(old), late]) {
    expect.soft(document.body).not.toHaveTextContent(marker);
    expect.soft(current.cache()).not.toContain(marker);
  }
  current.assertOwner();
}

describe("independent LLM same-owner denial and write-only boundaries", () => {
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

  it("positive: an ordinary same-owner parent 503 preserves the dirty note and read selection without a write", async () => {
    const current = await setup();
    await openDraft("note");
    current.state.parentStatus = 503;
    await current.refetch(["observability", "llm", "evaluations"], 2200);
    expect(
      current.calls.filter((call) => call.path === "/admin/llm/evaluations" && call.status === 503).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "새 메모" })).toHaveValue(draft);
    expect(screen.getByText(`기존 메모: ${old.note}`)).toBeVisible();
    expect(current.cache()).toContain(old.detail);
    expect(current.writes()).toHaveLength(0);
    current.assertOwner();
  });

  it("retires the denied request on same-owner detail 403 and does not resurrect it after 503 or successful parent refresh", async () => {
    const current = await setup({ teamReader: true });
    await openDetail();
    current.state.detailStatus = 403;
    await current.refetch(["observability", "llm", "trace", requestId]);
    expect(current.calls.filter((call) => call.path === detailPath && call.status === 403)).toHaveLength(1);
    expectRetired(current);
    current.state.detailStatus = 503;
    await current.refetch(["observability", "llm", "trace", requestId], 2200);
    expectRetired(current);
    current.state.detailStatus = 200;
    current.state.recovered = true;
    await click(screen.getByRole("button", { name: "새로고침", hidden: true }));
    expectRetired(current);
    // Preserve the first failed retirement assertion while still exercising explicit
    // reselection on C2, whose old error sheet otherwise covers the row button.
    const stale = screen.queryByRole("dialog", { name: "LLM 호출 상세" });
    if (stale) await click(within(stale).getByRole("button", { name: "패널 닫기" }));
    await click(screen.getByRole("button", { name: `${requestId} 호출 상세 열기` }));
    expect(screen.getByText(`${fresh} v2`)).toBeVisible();
    expect(current.writes()).toHaveLength(0);
  });

  it("does not publish a captured late explanation 200 after the same owner's request detail is denied", async () => {
    const current = await setup({ teamReader: true });
    await openDetail();
    current.hold();
    await current.refetch(["observability", "requests", requestId, "explain"]);
    current.state.detailStatus = 403;
    await current.refetch(["observability", "llm", "trace", requestId]);
    expect(current.calls.filter((call) => call.path === detailPath && call.status === 403)).toHaveLength(1);
    expectRetired(current);
    await current.release();
    expectRetired(current);
    expect(current.writes()).toHaveLength(0);
  });

  it.each(["note", "feedback"] as const)(
    "preserves and locks the %s draft through write-only scope and feature readOnly changes",
    async (kind) => {
      const current = await setup({ kind });
      await openDraft(kind);
      const title = kind === "note" ? "요청 메모·태그 수정" : "피드백 남기기";
      const label = kind === "note" ? "새 메모" : "의견";
      const submit = kind === "note" ? "메모·태그 저장" : "등록";
      const assertLocked = async () => {
        const dialog = screen.getByRole("dialog", { name: title });
        expect(within(dialog).getByRole("textbox", { name: label })).toHaveValue(draft);
        expect(within(dialog).getByRole("textbox", { name: label })).toBeDisabled();
        expect(within(dialog).getByRole("button", { name: submit })).toBeDisabled();
        const form = dialog.querySelector("form");
        if (!form)
          throw new Error("The existing draft form must stay mounted while only writes are disabled");
        fireEvent.submit(form);
        await advance();
        expect(current.writes()).toHaveLength(0);
        current.assertOwner();
      };
      await current.setWrite(false);
      await assertLocked();
      await current.setWrite(true);
      expect(screen.getByRole("textbox", { name: label })).toHaveValue(draft);
      expect(screen.getByRole("textbox", { name: label })).toBeEnabled();
      expect(current.writes()).toHaveLength(0);
      await click(screen.getByRole("button", { name: "테스트 읽기 전용 전환", hidden: true }));
      await assertLocked();
      await click(screen.getByRole("button", { name: "테스트 읽기 전용 전환", hidden: true }));
      expect(screen.getByRole("textbox", { name: label })).toHaveValue(draft);
      expect(screen.getByRole("textbox", { name: label })).toBeEnabled();
      expect(current.writes()).toHaveLength(0);
      await click(screen.getByRole("button", { name: submit }));
      expect(current.writes()).toHaveLength(1);
      expect(current.writes()[0]?.body).toMatchObject(
        kind === "note" ? { note: draft } : { request_id: requestId, comment: draft },
      );
      current.assertOwner();
    },
  );
});
