import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "@/app/auth/AuthProvider";
import { createAppQueryClient } from "@/app/providers/query-client";
import { ApiClient, apiClient } from "@/shared/api/client";
import type { UIBootstrap } from "@/shared/api/schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessHarness } from "@/test/feature-access";
import { LLMPage } from "./LLMPage";

const requestId = "public-terminal-request";
const detailPath = `/admin/llm/traces/${requestId}`;
const notePath = `/admin/requests/${requestId}/note`;
const feedbackPath = "/admin/llm/feedback";
const original = { detail: "PUBLIC-RETIRED-TRACE", note: "PUBLIC-RETIRED-NOTE" };
const freshNote = "PUBLIC-FRESH-NOTE-RECEIPT";
const replacement = "PUBLIC-USER-REPLACEMENT";
const clients: QueryClient[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function advance(milliseconds = 25) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}
async function click(element: HTMLElement) {
  fireEvent.click(element);
  await advance();
}
async function ready(check: () => boolean) {
  for (let turn = 0; turn < 20; turn += 1) {
    if (check()) return;
    await advance(5);
  }
  throw new Error("Synthetic initial/recovery control did not become ready within 100 ms");
}
function AuthProbe(): React.JSX.Element {
  const auth = useAuth();
  return (
    <output data-testid="terminal-auth">
      {JSON.stringify([
        auth.user?.id,
        auth.user?.role,
        auth.user?.team_id,
        auth.capabilities.raw_prompt_view,
      ])}
    </output>
  );
}

// Contract-derived synthetic HTTP, not a running Go/IdP test. A normal GET401
// refresh changes the access JWT's role/team before AuthProvider's next bootstrap.
// Thus browser owner/epoch stay admin/A while the new team_admin/B token gets403
// for this team-A request. This is not an admin-authorized server returning403.
async function setup() {
  const state = {
    principal: "public-subject-a",
    accessRole: "admin",
    expirePath: "",
    revision: 0,
    recovered: false,
    holdNote: false,
  };
  const calls: Array<{ path: string; method: string; status?: number }> = [];
  let finishNote: (() => void) | undefined;
  const noteGate = new Promise<void>((resolve) => {
    finishNote = resolve;
  });
  let finishWrite: ((status: number) => void) | undefined;
  const writeGate = new Promise<number>((resolve) => {
    finishWrite = resolve;
  });
  const successToast = vi.spyOn(toast, "success").mockReturnValue("public-success");
  const errorToast = vi.spyOn(toast, "error").mockReturnValue("public-error");
  const bootstrap = (): UIBootstrap => ({
    backend_version: "v0.86.45",
    ui_version: "v0.86.45",
    api_version: "v1",
    capabilities: { raw_prompt_view: true },
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
      id: state.principal,
      email: "public-operator@example.invalid",
      role: "admin",
      roles: ["admin"],
      team_id: "public-team-a",
      scopes: ["admin:read", "admin:write"],
      features: {},
    },
    roles: ["admin"],
    permissions: ["admin:read", "admin:write"],
    allowed_features: ["observability.llm"],
    migration_registry: [],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  });
  const note = () => ({
    request_id: requestId,
    note: state.recovered ? freshNote : original.note,
    tags: ["public-server-tag"],
    created_by: "public-operator",
    updated_at: "2026-10-08T08:59:30Z",
    exists: true,
    redacted_fields: [],
  });
  const transport = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input), "http://public-test.invalid").pathname;
      const method = init?.method ?? "GET";
      const call = { path, method, status: undefined as number | undefined };
      calls.push(call);
      const reply = (body: unknown, status = 200) => {
        call.status = status;
        return json(body, status);
      };
      if (path === "/auth/refresh" && method === "POST") {
        state.revision += 1;
        return reply({
          access_token: `public-${state.accessRole}-${state.revision}`,
          refresh_token: `public-refresh-${state.revision}`,
          token_type: "Bearer",
          expires_in: 300,
          refresh_expires_in: 600,
        });
      }
      if (method === "POST" && path === feedbackPath) {
        const status = await writeGate;
        return status === 201
          ? reply({ feedback: { id: "public-feedback", request_id: requestId, rating: 1 } }, status)
          : reply({ error: { message: "Synthetic delayed feedback failure", type: "server_error" } }, status);
      }
      if (method === "PATCH" && path === notePath) return reply(note());
      if (method !== "GET") throw new Error("Unexpected synthetic method");
      if (path === state.expirePath) {
        state.expirePath = "";
        return reply({ error: { message: "Expired synthetic access", type: "authentication_error" } }, 401);
      }
      if (path === "/admin/ui-bootstrap") return reply(bootstrap());
      if (
        state.accessRole === "team_admin" &&
        (path === detailPath || path.startsWith(`/admin/requests/${requestId}/`))
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
      if (path === "/admin/llm/evaluations")
        return reply({
          evaluations:
            state.accessRole === "team_admin"
              ? []
              : [
                  {
                    id: "public-evaluation",
                    request_id: requestId,
                    name: "public-quality",
                    reason: "Public received request",
                    created_at: "2026-10-08T08:59:30Z",
                  },
                ],
        });
      if (path === "/admin/llm/timeseries") return reply({ points: [] });
      if (path === feedbackPath) return reply({ feedback: [] });
      if (path === "/admin/llm/prompts") return reply({ prompts: [] });
      if (path === "/admin/llm/insights") return reply({ insights: [] });
      if (path === "/admin/llm/patterns") return reply({ patterns: [] });
      if (path === detailPath)
        return reply({
          request: {
            id: requestId,
            trace_id: "public-trace",
            prompt_name: state.recovered ? "PUBLIC-FRESH-TRACE" : original.detail,
            status_code: 200,
          },
          spans: [],
          evaluations: [],
          feedback: [],
          tools: [],
        });
      if (path === `/admin/requests/${requestId}/explain`)
        return reply({ request_id: requestId, routing: {} });
      if (path === `/admin/requests/${requestId}/trace`) return reply({ request_id: requestId, spans: [] });
      if (path === `/admin/requests/${requestId}/links`)
        return reply({ request_id: requestId, counts: {}, governance: { blocked: false } });
      if (path === notePath) {
        if (state.holdNote) await noteGate;
        return reply(note());
      }
      throw new Error(`Unexpected synthetic read: ${path}`);
    }),
    getAccessToken: tokenStore.getAccessToken,
    getRefreshToken: tokenStore.getRefreshToken,
    getLegacyToken: tokenStore.getLegacyToken,
    getSessionEpoch: tokenStore.getSessionEpoch,
    saveTokens: tokenStore.refreshTokens,
    clearTokens: tokenStore.clearTokens,
    notifyLogout: vi.fn(),
  });
  tokenStore.saveTokens({ access_token: "public-admin-initial", refresh_token: "public-refresh-initial" });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  const client = createAppQueryClient();
  clients.push(client);
  const invalidations = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/observability/llm?tab=evaluations"]}>
        <AuthProvider>
          <AuthProbe />
          <FeatureAccessHarness featureId="observability.llm">
            <LLMPage />
          </FeatureAccessHarness>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await ready(() => Boolean(screen.queryByRole("button", { name: `${requestId} 호출 상세 열기` })));
  const epoch = tokenStore.getSessionEpoch();
  const count = (method: string, path?: string) =>
    calls.filter((c) => c.method === method && (!path || c.path === path)).length;
  const assertSameOwner = () => {
    expect(screen.getByTestId("terminal-auth")).toHaveTextContent(
      JSON.stringify([state.principal, "admin", "public-team-a", true]),
    );
    expect(tokenStore.getSessionEpoch()).toBe(epoch);
  };
  const deny = async (resource: "note" | "trace") => {
    const path = resource === "note" ? notePath : detailPath;
    state.accessRole = "team_admin";
    state.expirePath = path;
    const beforeAccess = tokenStore.getAccessToken();
    const bootstraps = count("GET", "/admin/ui-bootstrap");
    act(() => {
      void client.invalidateQueries({
        queryKey:
          resource === "note"
            ? ["observability", "requests", requestId, "note"]
            : ["observability", "llm", "trace", requestId],
      });
    });
    await advance(100);
    expect(calls.filter((c) => c.path === path && c.status === 401)).toHaveLength(1);
    expect(calls.filter((c) => c.path === path && c.status === 403)).toHaveLength(1);
    expect(count("POST", "/auth/refresh")).toBe(1);
    expect(count("GET", "/admin/ui-bootstrap")).toBe(bootstraps);
    expect(tokenStore.getAccessToken()).not.toBe(beforeAccess);
    assertSameOwner();
  };
  const recoverList = async () => {
    state.accessRole = "admin";
    state.recovered = true;
    state.expirePath = "/admin/llm/evaluations";
    await click(screen.getByRole("button", { name: "새로고침", hidden: true }));
    await ready(() => Boolean(screen.queryByRole("button", { name: `${requestId} 호출 상세 열기` })));
    assertSameOwner();
  };
  return {
    state,
    calls,
    client,
    count,
    invalidations,
    successToast,
    errorToast,
    deny,
    recoverList,
    cache: () =>
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    writes: () =>
      calls.filter(
        (c) =>
          (c.method === "PATCH" && c.path === notePath) || (c.method === "POST" && c.path === feedbackPath),
      ),
    releaseNote: async () => {
      await act(async () => finishNote?.());
      await advance();
    },
    releaseWrite: async (status: number) => {
      await act(async () => finishWrite?.(status));
      await advance(100);
    },
    changePrincipal: async (id: string) => {
      state.principal = id;
      fireEvent(document, new Event("visibilitychange"));
      await advance(100);
      assertSameOwner();
    },
  };
}

async function openTrace() {
  await click(screen.getByRole("button", { name: `${requestId} 호출 상세 열기` }));
  expect(screen.getByText(original.detail)).toBeVisible();
}
async function openNoteDraft() {
  await openTrace();
  await click(screen.getByRole("button", { name: "원인 설명 열기" }));
  await click(screen.getByRole("button", { name: "메모·태그 수정" }));
  fireEvent.change(screen.getByRole("combobox", { name: "메모 변경 방법" }), {
    target: { value: "replace" },
  });
  await advance();
  fireEvent.change(screen.getByRole("textbox", { name: "새 메모" }), { target: { value: replacement } });
  await advance();
  expect(screen.getByRole("textbox", { name: "새 메모" })).toHaveValue(replacement);
}
function retirement(current: Awaited<ReturnType<typeof setup>>) {
  const observed = {
    dialogs: screen.queryAllByRole("dialog").length,
    oldDOM: Object.values(original).filter((marker) => document.body.textContent?.includes(marker)),
    oldCache: Object.values(original).filter((marker) => current.cache().includes(marker)),
    inputs: [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")].filter(
      (input) => input.value.includes(replacement),
    ).length,
  };
  expect.soft(observed).toEqual({ dialogs: 0, oldDOM: [], oldCache: [], inputs: 0 });
  expect.soft(JSON.stringify(localStorage)).not.toContain(replacement);
  expect.soft(JSON.stringify(sessionStorage)).not.toContain(replacement);
  return (
    observed.dialogs === 0 &&
    observed.oldDOM.length === 0 &&
    observed.oldCache.length === 0 &&
    observed.inputs === 0
  );
}
function stage(name: string, recoveryReached: boolean) {
  // Numeric/phase-only synthetic evidence; no credentials or user payload logs.
  console.info("LLM_TERMINAL_RECOVERY_STAGE", JSON.stringify({ name, recoveryReached }));
}

describe("independent LLM terminal denial and explicit user-input recovery", () => {
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

  it("retires dirty note data on terminal403 and restores only replacement input after explicit fresh same-request recovery", async () => {
    const current = await setup();
    await openNoteDraft();
    await current.deny("note");
    const hidden = retirement(current);
    expect.soft(current.writes()).toHaveLength(0);
    stage("same-owner-note", hidden);
    // The preceding soft assertion already fails the baseline test. Its absent
    // recovery UI must not replace that real boundary failure with helper noise.
    if (!hidden) return;
    await current.recoverList();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "새 메모" })).not.toBeInTheDocument();
    expect(current.writes()).toHaveLength(0);
    const notesBefore = current.count("GET", notePath);
    current.state.holdNote = true;
    await click(screen.getByRole("button", { name: `${requestId} 호출 상세 열기` }));
    expect(screen.getByText("PUBLIC-FRESH-TRACE")).toBeVisible();
    await click(screen.getByRole("button", { name: "원인 설명 열기" }));
    const confirmation = screen.getByRole("alertdialog");
    await click(within(confirmation).getByRole("button", { name: "계속 편집" }));
    expect(screen.getByRole("textbox", { name: "새 메모" })).toHaveValue(replacement);
    expect(screen.getByRole("combobox", { name: "메모 변경 방법" })).toHaveValue("replace");
    expect(screen.getByRole("button", { name: "메모·태그 저장" })).toBeDisabled();
    expect(document.body).not.toHaveTextContent(original.note);
    expect(document.body).not.toHaveTextContent(freshNote);
    expect(current.count("GET", notePath)).toBeGreaterThan(notesBefore);
    await current.releaseNote();
    expect(screen.getByText(`재조회한 메모: ${freshNote}`)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "새 메모" })).toHaveValue(replacement);
    expect(screen.getByRole("button", { name: "메모·태그 저장" })).toBeEnabled();
    expect(current.writes()).toHaveLength(0);
  });

  it("does not recover a retained replacement across principal A to B to A after terminal denial", async () => {
    const current = await setup();
    await openNoteDraft();
    await current.deny("note");
    const hidden = retirement(current);
    stage("note-owner-aba", hidden);
    if (!hidden) return;
    await current.changePrincipal("public-subject-b");
    retirement(current);
    await current.changePrincipal("public-subject-a");
    retirement(current);
    await current.recoverList();
    await click(screen.getByRole("button", { name: `${requestId} 호출 상세 열기` }));
    await click(screen.getByRole("button", { name: "원인 설명 열기" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await click(screen.getByRole("button", { name: "메모·태그 수정" }));
    expect(screen.getByRole("combobox", { name: "메모 변경 방법" })).toHaveValue("preserve");
    expect(document.body).not.toHaveTextContent(replacement);
    for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea"))
      expect(input.value).not.toContain(replacement);
    expect(current.writes()).toHaveLength(0);
  });

  it.each([201, 503])(
    "suppresses a pending feedback's late %s after same-owner terminal trace denial",
    async (status) => {
      const current = await setup();
      await openTrace();
      await click(screen.getByRole("button", { name: "피드백 남기기" }));
      fireEvent.change(screen.getByRole("textbox", { name: "의견" }), { target: { value: replacement } });
      await click(screen.getByRole("button", { name: "등록" }));
      expect(current.writes()).toHaveLength(1);
      await current.deny("trace");
      retirement(current);
      current.invalidations.mockClear();
      const getCount = current.count("GET");
      await current.releaseWrite(status);
      expect.soft(current.successToast).not.toHaveBeenCalled();
      expect.soft(current.errorToast).not.toHaveBeenCalled();
      expect.soft(current.invalidations).not.toHaveBeenCalled();
      expect.soft(current.count("GET")).toBe(getCount);
      expect.soft(current.writes()).toHaveLength(1);
      retirement(current);
      stage(`pending-feedback-${status}`, false);
    },
  );
});
