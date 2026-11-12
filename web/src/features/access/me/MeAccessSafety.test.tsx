import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { tokenStore } from "@/shared/auth/token-store";
import { MeKeysTab } from "./MeKeysTab";

const identity = vi.hoisted(() => ({ id: "public-user", readOnly: false }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        role: "developer",
        scopes: ["models:read"],
        user: { id: identity.id, team_id: "public-team" },
      }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const sessionRows = {
  current_session_id: "current",
  sessions: [
    { id: "current", current: true, ip: "192.0.2.1", user_agent: "현재 브라우저" },
    { id: "public-device", current: false, ip: "192.0.2.2", user_agent: "다른 브라우저" },
  ],
};
const urls = { base_url: "https://gateway.example/v1", mcp_url: "https://gateway.example/mcp/gateway" };
const diagnosis = {
  ...urls,
  client: "openai-sdk",
  overall: "pass",
  auth_mode: "jwt",
  checks: [{ name: "endpoint_reachability", status: "skip", detail: "공개 검사 결과" }],
};
function Location() {
  return <output data-testid="location">{useLocation().search}</output>;
}
function setup(extra: Record<string, ApiHandler> = {}, route = "/me?tab=keys") {
  const api = mockApi({
    "GET /me/keys": () => ({ api_keys: [], role: "developer", grantable_scopes: ["models:read"] }),
    "GET /me/sessions": () => sessionRows,
    "GET /me/onboarding-pack": (options) => ({
      ...urls,
      client: (options.query as { client: string }).client,
      available_models: [],
      recommended_models: [],
      scopes: [],
      config: "private server command",
    }),
    "POST /me/connection-doctor": () => diagnosis,
    "DELETE /me/sessions/public-device": () => ({ status: "revoked", session_id: "public-device" }),
    "POST /me/sessions/revoke-others": () => ({ status: "revoked", revoked_count: 1 }),
    ...extra,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Location />
        <FeatureAccessContext.Provider
          value={{ featureId: "me.home", permitted: true, status: "preview", readOnly: identity.readOnly }}
        >
          <MeKeysTab />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, api, client, refresh: () => view.rerender(tree()) };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function openSession(user: ReturnType<typeof userEvent.setup>) {
  const row = (await screen.findByText("다른 브라우저")).closest("tr");
  if (!row) throw new Error("session row missing");
  await user.click(within(row).getByRole("button", { name: "종료" }));
  return screen.getByRole("dialog", { name: "세션 종료" });
}
beforeEach(() => {
  identity.id = "public-user";
  identity.readOnly = false;
  tokenStore.clearAll();
});

it("protects the current session and confirms metadata before a fresh read and revoke", async () => {
  const user = userEvent.setup(),
    app = setup();
  const current = (await screen.findByText("현재 브라우저")).closest("tr");
  if (!current) throw new Error("current session row missing");
  expect(within(current).getByRole("button", { name: "종료" })).toBeDisabled();
  const dialog = await openSession(user);
  expect(within(dialog).getByText("192.0.2.2")).toBeVisible();
  expect(app.api.bodies("DELETE /me/sessions/public-device")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "종료" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  const calls = app.api.calls.map((c) => c.key);
  expect(calls.filter((c) => c === "GET /me/sessions").length).toBeGreaterThanOrEqual(3);
  const write = calls.indexOf("DELETE /me/sessions/public-device");
  expect(calls[write - 1]).toBe("GET /me/sessions");
  expect(app.api.spy.mock.calls.find(([e]) => e.method === "DELETE")?.[1]).toMatchObject({
    retryUnauthorized: false,
  });
});
it("closes a bulk review without writing when the active-session set changes", async () => {
  const user = userEvent.setup();
  let changed = false;
  const app = setup({
    "GET /me/sessions": () =>
      changed
        ? { ...sessionRows, sessions: [...sessionRows.sessions, { id: "new-device", current: false }] }
        : sessionRows,
  });
  await screen.findByText("다른 브라우저");
  await user.click(screen.getByRole("button", { name: "다른 세션 모두 종료" }));
  changed = true;
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "모두 종료" }));
  await screen.findByText(/세션 목록이 변경됐습니다/u);
  expect(app.api.bodies("POST /me/sessions/revoke-others")).toHaveLength(0);
});
it("keeps an incorrect revoke acknowledgment locked instead of submitting twice", async () => {
  const user = userEvent.setup();
  const app = setup({
    "DELETE /me/sessions/public-device": () => ({ status: "revoked", session_id: "another-device" }),
  });
  const dialog = await openSession(user);
  await user.click(within(dialog).getByRole("button", { name: "종료" }));
  await within(dialog).findByRole("alert");
  expect(within(dialog).getByRole("button", { name: "종료" })).toBeDisabled();
  await user.click(within(dialog).getByRole("button", { name: "취소" }));
  expect(screen.getByRole("button", { name: "다른 세션 모두 종료" })).toBeDisabled();
  expect(app.api.bodies("DELETE /me/sessions/public-device")).toHaveLength(1);
});
it.each([401, 403])("does not replay denied session writes (%s) and clears access data", async (status) => {
  const user = userEvent.setup();
  const app = setup({
    "DELETE /me/sessions/public-device": () => {
      throw apiFailure("private response", status);
    },
  });
  const dialog = await openSession(user);
  await user.click(within(dialog).getByRole("button", { name: "종료" }));
  await screen.findByRole("heading", { name: "개인 조회 권한을 확인하세요." });
  expect(app.api.bodies("DELETE /me/sessions/public-device")).toHaveLength(1);
  expect(screen.queryByText("다른 브라우저")).not.toBeInTheDocument();
  expect(
    app.client
      .getQueryCache()
      .getAll()
      .some((q) => q.queryKey.includes("me-access-read")),
  ).toBe(false);
});
it("restores session search from the URL", async () => {
  setup({}, "/me?tab=keys&login_sessions_q=192.0.2.2&login_sessions_sort=ip&login_sessions_direction=desc");
  await screen.findByText("다른 브라우저");
  expect(screen.queryByText("현재 브라우저")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "로그인 세션 검색어" })).toHaveValue("192.0.2.2");
});
it("runs connection inspection only on explicit clicks, including after global refresh/focus", async () => {
  const user = userEvent.setup(),
    app = setup();
  await screen.findByText("다른 브라우저");
  expect(app.api.bodies("POST /me/connection-doctor")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "진단 실행" }));
  await screen.findByText("공개 검사 결과");
  await act(async () => {
    await app.client.invalidateQueries();
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  expect(app.api.bodies("POST /me/connection-doctor")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "진단 실행" }));
  await waitFor(() => expect(app.api.bodies("POST /me/connection-doctor")).toHaveLength(2));
  focusManager.setFocused(undefined);
});
it("locks diagnostic retries after a read-only transition", async () => {
  const user = userEvent.setup();
  const app = setup({
    "POST /me/connection-doctor": () => {
      throw apiFailure("private diagnosis");
    },
  });
  await screen.findByText("다른 브라우저");
  await user.click(screen.getByRole("button", { name: "진단 실행" }));
  const retry = await screen.findByRole("button", { name: "다시 조회" });
  identity.readOnly = true;
  app.refresh();
  expect(retry).toBeDisabled();
  expect(app.api.bodies("POST /me/connection-doctor")).toHaveLength(1);
});
it("isolates a late diagnostic result when the selected client changes", async () => {
  const user = userEvent.setup(),
    pending = deferred();
  const app = setup({ "POST /me/connection-doctor": () => pending.promise });
  await screen.findByText("다른 브라우저");
  await user.click(screen.getByRole("button", { name: "진단 실행" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "클라이언트" }), "cursor");
  await act(async () => pending.resolve(diagnosis));
  expect(screen.queryByText("공개 검사 결과")).not.toBeInTheDocument();
  expect(screen.getByTestId("location")).toHaveTextContent("connection_client=cursor");
  expect(app.api.bodies("POST /me/connection-doctor")).toHaveLength(1);
});
it("uses safe generated setup examples and permits another explicit metadata refresh", async () => {
  const user = userEvent.setup(),
    app = setup();
  await screen.findByText("다른 브라우저");
  await user.click(screen.getByRole("button", { name: "설정 불러오기" }));
  await screen.findByRole("region", { name: "Python SDK 설정 내용" });
  expect(screen.queryByText("private server command")).not.toBeInTheDocument();
  expect(
    JSON.stringify(
      app.client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain("private server command");
  await user.click(screen.getByRole("button", { name: "설정 불러오기" }));
  await waitFor(() =>
    expect(app.api.calls.filter((c) => c.key === "GET /me/onboarding-pack")).toHaveLength(2),
  );
});
it("discards a late session response after an account change", async () => {
  const pending = deferred();
  const app = setup({
    "GET /me/sessions": () =>
      identity.id === "public-user" ? pending.promise : { current_session_id: "new-current", sessions: [] },
  });
  identity.id = "other-user";
  app.refresh();
  await act(async () => pending.resolve(sessionRows));
  expect(screen.queryByText("다른 브라우저")).not.toBeInTheDocument();
  expect(
    JSON.stringify(
      app.client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain("192.0.2.2");
});
