import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "@/app/auth/AuthProvider";
import { createAppQueryClient } from "@/app/providers/query-client";
import { LLMPage } from "./LLMPage";
import { ApiClient, apiClient } from "@/shared/api/client";
import type { UIBootstrap } from "@/shared/api/schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessHarness } from "@/test/feature-access";

const requestId = "public-llm-write-owner-request";
const notePath = `/admin/requests/${requestId}/note`;
const feedbackPath = "/admin/llm/feedback";
const originalNote = "public-original-note@example.invalid";
const noteDraft = "PUBLIC-OPERATOR-NOTE-DRAFT";
const feedbackDraft = "PUBLIC-OPERATOR-FEEDBACK-DRAFT";
const errorCorrelation = "PUBLIC-RETIRED-WRITE-ERROR";
const clients: QueryClient[] = [];
type Transition = "principal" | "raw-role-down" | "team-role-down";
type WriteKind = "note" | "feedback";
type Outcome = "success" | "failure" | "unauthorized";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
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
function AuthProbe(): React.JSX.Element {
  const auth = useAuth();
  return (
    <output data-testid="llm-write-auth">
      {JSON.stringify([
        auth.mode,
        auth.user?.id,
        auth.user?.role,
        auth.user?.team_id,
        auth.capabilities.raw_prompt_view,
      ])}
    </output>
  );
}

async function setup({ kind = "note", outcome = "success" }: { kind?: WriteKind; outcome?: Outcome } = {}) {
  const identity = { id: "public-admin-a", role: "admin", team: "public-team-a" };
  const calls: Array<{ method: string; path: string }> = [];
  const successToast = vi.spyOn(toast, "success").mockReturnValue("public-toast");
  const errorToast = vi.spyOn(toast, "error").mockReturnValue("public-toast");
  let access = "public-synthetic-access-before";
  let releaseWrite: ((value: Response) => void) | undefined;
  let writeStarted = false;
  const pendingWrite = new Promise<Response>((resolve) => {
    releaseWrite = resolve;
  });
  const raw = () => identity.role === "admin";
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
        id: identity.id,
        email: "public-operator@example.invalid",
        role: identity.role,
        roles: [identity.role],
        team_id: identity.team,
        scopes: scopes(),
        features: {},
      },
      roles: [identity.role],
      permissions: scopes(),
      allowed_features: ["observability.llm"],
      migration_registry: [],
      system_status: { status: "healthy" },
      legacy_route_map: {},
    };
  }
  const note = () => ({
    request_id: requestId,
    note: raw() ? originalNote : "[REDACTED_EMAIL]",
    tags: ["public-tag"],
    created_by: "public-operator",
    updated_at: "2026-10-08T08:59:30Z",
    exists: true,
    redacted_fields: raw() ? [] : ["note"],
  });
  const ack = () =>
    kind === "note"
      ? note()
      : { feedback: { id: "public-feedback", request_id: requestId, rating: 1, comment: feedbackDraft } };
  const transport = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input), "http://public-test.invalid").pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (method === "POST" && path === "/auth/refresh")
        return json({
          access_token: "public-synthetic-access-after",
          refresh_token: "public-synthetic-refresh-after",
          token_type: "Bearer",
          expires_in: 300,
          refresh_expires_in: 600,
        });
      if ((method === "PATCH" && path === notePath) || (method === "POST" && path === feedbackPath)) {
        if (!writeStarted) {
          writeStarted = true;
          return pendingWrite;
        }
        // This branch exposes an actual ApiClient replay, not a mocked retry.
        return json(ack(), kind === "feedback" ? 201 : 200);
      }
      if (method !== "GET") throw new Error("Unexpected synthetic write");
      if (path === "/admin/ui-bootstrap") return json(bootstrap());
      if (
        identity.role === "team_admin" &&
        (path.startsWith(`/admin/requests/${requestId}/`) || path === `/admin/llm/traces/${requestId}`)
      )
        return json(
          {
            error: {
              message: "request is outside your team scope",
              type: "permission_error",
              code: "cross_team_access_denied",
            },
          },
          403,
        );
      if (path === "/admin/llm/timeseries") return json({ points: [] });
      if (path === "/admin/llm/evaluations")
        return json({
          evaluations:
            identity.role === "team_admin"
              ? []
              : [
                  {
                    id: "public-evaluation",
                    request_id: requestId,
                    name: "public-quality",
                    reason: "public-reason",
                    created_at: "2026-10-08T08:59:30Z",
                  },
                ],
        });
      if (path === feedbackPath) return json({ feedback: [] });
      if (path === "/admin/llm/prompts") return json({ prompts: [] });
      if (path === "/admin/llm/insights") return json({ insights: [] });
      if (path === "/admin/llm/patterns") return json({ patterns: [] });
      if (path === `/admin/llm/traces/${requestId}`)
        return json({
          request: {
            id: requestId,
            trace_id: "public-trace",
            prompt_name: "public-prompt",
            status_code: 200,
          },
          spans: [],
          evaluations: [],
          feedback: [],
          tools: [],
        });
      if (path === `/admin/requests/${requestId}/explain`)
        return json({ request_id: requestId, routing: {} });
      if (path === `/admin/requests/${requestId}/trace`) return json({ request_id: requestId, spans: [] });
      if (path === `/admin/requests/${requestId}/links`)
        return json({ request_id: requestId, counts: {}, governance: { blocked: false } });
      if (path === notePath) return json(note());
      throw new Error(`Unexpected synthetic read: ${path}`);
    }),
    getAccessToken: () => access,
    getRefreshToken: () => (outcome === "unauthorized" ? "public-synthetic-refresh-before" : ""),
    getLegacyToken: () => "",
    getSessionEpoch: tokenStore.getSessionEpoch,
    saveTokens: (tokens) => {
      access = tokens.access_token;
    },
    clearTokens: vi.fn(),
    notifyLogout: vi.fn(),
  });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  const client = createAppQueryClient();
  clients.push(client);
  const invalidations = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[`/observability/llm?tab=${kind === "feedback" ? "feedback" : "evaluations"}`]}
      >
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
    kind === "feedback" ? "피드백 남기기" : `${requestId} 호출 상세 열기`,
    kind === "feedback" ? "feedback" : "evaluations",
  );
  const epoch = tokenStore.getSessionEpoch();
  const count = (method: string, path?: string) =>
    calls.filter((call) => call.method === method && (!path || call.path === path)).length;
  const changeOwner = async (transition: Transition) => {
    if (transition === "principal") identity.id = "public-admin-b";
    if (transition === "raw-role-down") identity.role = "readonly_admin";
    if (transition === "team-role-down")
      Object.assign(identity, { role: "team_admin", team: "public-team-b" });
    const before = count("GET", "/admin/ui-bootstrap");
    fireEvent(document, new Event("visibilitychange"));
    await advance(100);
    expect(count("GET", "/admin/ui-bootstrap")).toBe(before + 1);
    expect(screen.getByTestId("llm-write-auth")).toHaveTextContent(
      JSON.stringify(["authenticated", identity.id, identity.role, identity.team, raw()]),
    );
    expect(tokenStore.getSessionEpoch()).toBe(epoch);
  };
  const release = async () => {
    expect(writeStarted).toBe(true);
    if (!releaseWrite) throw new Error("Synthetic write has no resolver");
    const response =
      outcome === "success"
        ? json(ack(), kind === "feedback" ? 201 : 200)
        : json(
            { error: { message: "Synthetic old write failure", type: "api_error" } },
            outcome === "failure" ? 503 : 401,
            { "X-Request-ID": errorCorrelation },
          );
    await act(async () => releaseWrite?.(response));
    await advance(100);
  };
  return { client, calls, count, changeOwner, release, invalidations, successToast, errorToast, epoch };
}

async function openNote(dirty = false) {
  await click(screen.getByRole("button", { name: `${requestId} 호출 상세 열기` }));
  await click(screen.getByRole("button", { name: "원인 설명 열기" }));
  await click(screen.getByRole("button", { name: "메모·태그 수정" }));
  const dialog = screen.getByRole("dialog", { name: "요청 메모·태그 수정" });
  expect(within(dialog).getByText(`기존 메모: ${originalNote}`)).toBeVisible();
  if (dirty) {
    fireEvent.change(within(dialog).getByRole("combobox", { name: "메모 변경 방법" }), {
      target: { value: "replace" },
    });
    await advance();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "새 메모" }), {
      target: { value: noteDraft },
    });
    await advance();
    expect(within(dialog).getByRole("textbox", { name: "새 메모" })).toHaveValue(noteDraft);
  }
}
async function openFeedback() {
  await click(screen.getByRole("button", { name: "피드백 남기기" }));
  const dialog = screen.getByRole("dialog", { name: "피드백 남기기" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "요청 ID" }), {
    target: { value: requestId },
  });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "의견" }), {
    target: { value: feedbackDraft },
  });
  await advance();
  expect(within(dialog).getByRole("textbox", { name: "의견" })).toHaveValue(feedbackDraft);
}
function expectDraftHidden(kind: WriteKind) {
  const title = kind === "note" ? "요청 메모·태그 수정" : "피드백 남기기";
  const draft = kind === "note" ? noteDraft : feedbackDraft;
  expect.soft(screen.queryByRole("dialog", { name: title })).not.toBeInTheDocument();
  for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea"))
    expect.soft(input.value).not.toContain(draft);
  expect.soft(document.body).not.toHaveTextContent(draft);
}

describe("independent LLM note and feedback owner boundaries", () => {
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

  it.each(["note", "feedback"] as const)(
    "positive: normal same-owner parent refetch preserves the %s draft",
    async (kind) => {
      const current = await setup({ kind });
      if (kind === "note") await openNote(true);
      else await openFeedback();
      await act(async () => {
        await current.client.invalidateQueries({ queryKey: ["observability", "llm"] });
      });
      await advance();
      expect(screen.getByRole("textbox", { name: kind === "note" ? "새 메모" : "의견" })).toHaveValue(
        kind === "note" ? noteDraft : feedbackDraft,
      );
      expect(current.count(kind === "note" ? "PATCH" : "POST")).toBe(0);
    },
  );

  it.each(["principal", "raw-role-down", "team-role-down"] as const)(
    "retires a pristine open note baseline/cache on %s",
    async (transition) => {
      const current = await setup();
      await openNote();
      await current.changeOwner(transition);
      expectDraftHidden("note");
      expect.soft(document.body).not.toHaveTextContent(originalNote);
      expect
        .soft(
          JSON.stringify(
            current.client
              .getQueryCache()
              .getAll()
              .map((query) => query.state.data),
          ),
        )
        .not.toContain(originalNote);
    },
  );

  it.each(["principal", "raw-role-down", "team-role-down"] as const)(
    "hides an already dirty note draft on %s",
    async (transition) => {
      const current = await setup();
      await openNote(true);
      await current.changeOwner(transition);
      expectDraftHidden("note");
      expect.soft(document.body).not.toHaveTextContent(originalNote);
      expect(current.count("PATCH")).toBe(0);
    },
  );

  it.each(["principal", "raw-role-down", "team-role-down"] as const)(
    "hides an already dirty feedback form on %s",
    async (transition) => {
      const current = await setup({ kind: "feedback" });
      await openFeedback();
      await current.changeOwner(transition);
      expectDraftHidden("feedback");
      expect(current.count("POST")).toBe(0);
    },
  );

  for (const kind of ["note", "feedback"] as const) {
    it.each(["success", "failure"] as const)(
      `suppresses retired ${kind} late %s feedback and follow-up reads`,
      async (outcome) => {
        const current = await setup({ kind, outcome });
        if (kind === "note") await openNote(true);
        else await openFeedback();
        await click(screen.getByRole("button", { name: kind === "note" ? "메모·태그 저장" : "등록" }));
        const method = kind === "note" ? "PATCH" : "POST";
        const path = kind === "note" ? notePath : feedbackPath;
        expect(current.count(method, path)).toBe(1);
        await current.changeOwner("principal");
        current.invalidations.mockClear();
        current.successToast.mockClear();
        current.errorToast.mockClear();
        const reads = current.count("GET");
        await current.release();
        expectDraftHidden(kind);
        expect.soft(current.successToast).not.toHaveBeenCalled();
        expect.soft(current.errorToast).not.toHaveBeenCalled();
        expect.soft(current.invalidations).not.toHaveBeenCalled();
        expect.soft(current.count("GET")).toBe(reads);
        expect.soft(document.body).not.toHaveTextContent(errorCorrelation);
        expect(current.count(method, path)).toBe(1);
      },
    );

    it(`does not automatically replay a retired ${kind} write after a late 401 and token refresh`, async () => {
      const current = await setup({ kind, outcome: "unauthorized" });
      if (kind === "note") await openNote(true);
      else await openFeedback();
      await click(screen.getByRole("button", { name: kind === "note" ? "메모·태그 저장" : "등록" }));
      const method = kind === "note" ? "PATCH" : "POST";
      const path = kind === "note" ? notePath : feedbackPath;
      expect(current.count(method, path)).toBe(1);
      await current.changeOwner("principal");
      current.invalidations.mockClear();
      current.successToast.mockClear();
      current.errorToast.mockClear();
      const reads = current.count("GET");
      await current.release();
      expect.soft(current.count(method, path)).toBe(1);
      expect.soft(current.count("POST", "/auth/refresh")).toBe(0);
      expect.soft(current.successToast).not.toHaveBeenCalled();
      expect.soft(current.errorToast).not.toHaveBeenCalled();
      expect.soft(current.invalidations).not.toHaveBeenCalled();
      expect.soft(current.count("GET")).toBe(reads);
      expect(tokenStore.getSessionEpoch()).toBe(current.epoch);
    });
  }
});
