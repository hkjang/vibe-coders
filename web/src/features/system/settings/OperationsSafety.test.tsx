import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";

import { OperationsTab } from "./OperationsTab";
import { systemSettingsKeys } from "./use-system-settings";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";

const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notices }));
const identity = vi.hoisted(() => ({ id: "operator-a", team: "team-a", readable: true }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        scopes: identity.readable ? ["admin:read", "admin:write"] : [],
        user: { id: identity.id, team_id: identity.team },
      }),
  };
});

const retention = {
  request_days: 90,
  prompt_days: 30,
  response_days: 30,
  requests: 1200,
  prompts: 400,
  responses: 380,
  last_run_at: "",
  last_deleted: 12,
};
const fallback = { path: "/data/fallback.ndjson", exists: true, bytes: 2048, lines: 7, modified_at: "" };
const replay = { imported: 3, duplicates: 1, failed: 0, remaining: 0 };
const runtime = { readOnly: false, write: true };
beforeEach(() => {
  identity.id = "operator-a";
  identity.team = "team-a";
  identity.readable = true;
  runtime.readOnly = false;
  runtime.write = true;
  notices.success.mockClear();
  notices.error.mockClear();
});
function setup(extra: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/retention": () => retention,
    "GET /admin/fallback": () => fallback,
    "GET /admin/notifications/mattermost": () => ({
      enabled: false,
      channel: "ops",
      events: [],
      webhook_url: "",
    }),
    "POST /admin/retention": () => retention,
    "POST /admin/fallback": () => replay,
    "POST /admin/notifications/mattermost/test": () => ({ ok: true }),
    ...extra,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FeatureAccessContext.Provider
          value={{ featureId: "system.settings", readOnly: runtime.readOnly, permitted: true }}
        >
          <OperationsTab hasAdminWrite={runtime.write} />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(tree()), tree, api, client };
}

it.each([401, 403])("서버 %s 응답 시 이전 운영 데이터와 실행을 감춘다", async (status) => {
  let denied = false;
  const view = setup({
    "GET /admin/fallback": () => {
      if (denied) throw apiFailure("denied", status);
      return fallback;
    },
    "GET /admin/notifications/mattermost": () => {
      if (denied) throw apiFailure("denied", status);
      return { enabled: false, channel: "ops", events: [] };
    },
    "GET /admin/retention": () => {
      if (denied) throw apiFailure("denied", status);
      return retention;
    },
  });
  await screen.findByText("/data/fallback.ndjson");
  denied = true;
  await act(async () => {
    await view.client.invalidateQueries();
  });
  await waitFor(() => expect(screen.queryByText("/data/fallback.ndjson")).not.toBeInTheDocument());
  expect(screen.queryByLabelText("채널")).not.toBeInTheDocument();
  expect(screen.queryByText("저장된 요청")).not.toBeInTheDocument();
  for (const name of ["지금 정리 실행", "DB로 재처리", "테스트 메시지 발송"])
    expect(screen.getByRole("button", { name })).toBeDisabled();
  expect(screen.queryByText("마지막으로 확인된 값을 표시하고 있습니다.")).not.toBeInTheDocument();
});

it.each(
  [401, 403].flatMap((status) =>
    (["retention", "fallback", "notifications"] as const).map((key) => ({ status, key })),
  ),
)("$key 하나의 $status 응답도 탭 전체를 잠그며 재조회 성공만으로 풀리지 않는다", async ({ status, key }) => {
  const path = {
    retention: "/admin/retention",
    fallback: "/admin/fallback",
    notifications: "/admin/notifications/mattermost",
  }[key];
  let denied = false;
  const view = setup({
    [`GET ${path}`]: () => {
      if (denied) throw apiFailure("denied", status);
      return { retention, fallback, notifications: { enabled: false, channel: "ops", events: [] } }[key];
    },
  });
  const user = userEvent.setup();
  await screen.findByText("/data/fallback.ndjson");
  await user.click(screen.getByRole("button", { name: "지금 정리 실행" }));
  const dialog = within(screen.getByRole("dialog"));
  await user.type(dialog.getByLabelText(/변경 사유/), "운영 확인");
  await user.type(dialog.getByLabelText(/확인 문구/), "데이터 정리");
  denied = true;
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: systemSettingsKeys[key] });
  });
  await waitFor(() => expect(screen.queryByText("/data/fallback.ndjson")).not.toBeInTheDocument());
  denied = false;
  await act(async () => {
    await view.client.invalidateQueries();
  });
  expect(screen.queryByText("저장된 요청")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("채널")).not.toBeInTheDocument();
  expect(dialog.getByRole("button", { name: "정리 실행" })).toBeDisabled();
  await user.keyboard("{Enter}");
  await user.keyboard("{Escape}");
  for (const name of ["지금 정리 실행", "DB로 재처리", "테스트 메시지 발송"])
    expect(screen.getByRole("button", { name })).toBeDisabled();
  expect(view.api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
  // An authenticated owner change starts with fresh, owned queries.
  identity.id = "operator-b";
  view.rerender(view.tree());
  await screen.findByText("/data/fallback.ndjson");
  expect(screen.getByRole("button", { name: "지금 정리 실행" })).toBeEnabled();
});

it("계정 전환 후 이전 작업의 늦은 완료를 알리지 않는다", async () => {
  let finish: (value: typeof replay) => void = () => undefined;
  const view = setup({
    "POST /admin/fallback": () =>
      new Promise<typeof replay>((resolve) => {
        finish = resolve;
      }),
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "DB로 재처리" }));
  await user.type(within(screen.getByRole("dialog")).getByLabelText(/확인 문구/), "로그 재처리");
  await user.type(within(screen.getByRole("dialog")).getByLabelText(/변경 사유/), "운영 확인");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "재처리 실행" }));
  await waitFor(() => expect(view.api.calls.some((call) => call.key === "POST /admin/fallback")).toBe(true));
  identity.id = "operator-b";
  view.rerender(view.tree());
  await act(async () => finish(replay));
  expect(notices.success).not.toHaveBeenCalled();
  expect(notices.error).not.toHaveBeenCalled();
  expect(screen.queryByText("재처리 결과")).not.toBeInTheDocument();
});

it("다른 운영 조회의 권한 거부 후 늦게 완료된 작업을 알리지 않는다", async () => {
  let finish: (value: typeof replay) => void = () => undefined;
  let denied = false;
  const view = setup({
    "POST /admin/fallback": () =>
      new Promise<typeof replay>((resolve) => {
        finish = resolve;
      }),
    "GET /admin/retention": () => {
      if (denied) throw apiFailure("denied", 403);
      return retention;
    },
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "DB로 재처리" }));
  const dialog = within(screen.getByRole("dialog"));
  await user.type(dialog.getByLabelText(/확인 문구/), "로그 재처리");
  await user.type(dialog.getByLabelText(/변경 사유/), "운영 확인");
  await user.click(dialog.getByRole("button", { name: "재처리 실행" }));
  await waitFor(() => expect(view.api.calls.some((call) => call.key === "POST /admin/fallback")).toBe(true));
  denied = true;
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: systemSettingsKeys.retention });
  });
  await waitFor(() => expect(screen.queryByText("/data/fallback.ndjson")).not.toBeInTheDocument());
  await act(async () => finish(replay));
  expect(notices.success).not.toHaveBeenCalled();
  expect(notices.error).not.toHaveBeenCalled();
  expect(screen.queryByText("재처리 결과")).not.toBeInTheDocument();
});

it.each(["account", "team", "read"])("%s 변경 시 이전 확인창과 운영 데이터를 폐기한다", async (kind) => {
  const view = setup();
  const user = userEvent.setup();
  await screen.findByText("/data/fallback.ndjson");
  await user.click(screen.getByRole("button", { name: "지금 정리 실행" }));
  await user.type(within(screen.getByRole("dialog")).getByLabelText(/변경 사유/), "이전 계정의 사유");
  view.api.spy.mockImplementation(() => new Promise(() => undefined));
  if (kind === "account") identity.id = "operator-b";
  else if (kind === "team") identity.team = "team-b";
  else identity.readable = false;
  view.rerender(view.tree());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText("/data/fallback.ndjson")).not.toBeInTheDocument();
  expect(view.api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
});

it.each(["지금 정리 실행", "DB로 재처리", "테스트 메시지 발송"])(
  "읽기 전용에서는 %s을 실행하지 않는다",
  async (name) => {
    runtime.readOnly = true;
    const { api } = setup();
    await screen.findByText("/data/fallback.ndjson");
    expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
  },
);

it.each(["readonly", "scope"])("열린 정리 확인의 사유를 보존하고 %s 전환 시 실행을 잠근다", async (mode) => {
  const view = setup();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "지금 정리 실행" }));
  const dialog = screen.getByRole("dialog", { name: "지금 정리 실행" });
  await user.type(within(dialog).getByLabelText(/변경 사유/), "보존할 운영 사유");
  await user.type(within(dialog).getByLabelText(/확인 문구/), "데이터 정리");
  expect(within(dialog).getByRole("button", { name: "정리 실행" })).toBeEnabled();
  if (mode === "readonly") runtime.readOnly = true;
  else runtime.write = false;
  view.rerender(view.tree());
  expect(within(dialog).getByLabelText(/변경 사유/)).toHaveValue("보존할 운영 사유");
  expect(within(dialog).getByLabelText(/확인 문구/)).toHaveValue("데이터 정리");
  expect(within(dialog).getByRole("button", { name: "정리 실행" })).toBeDisabled();
  await user.keyboard("{Enter}");
  expect(view.api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
});

it.each([
  ["지금 정리 실행", "정리 실행", "/admin/retention"],
  ["DB로 재처리", "재처리 실행", "/admin/fallback"],
  ["테스트 메시지 발송", "", "/admin/notifications/mattermost/test"],
])("%s 요청은 자동 인증 재전송을 하지 않는다", async (open, confirm, path) => {
  const { api } = setup();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: open }));
  if (confirm) {
    const dialog = screen.getByRole("dialog");
    const reason = within(dialog).queryByLabelText(/변경 사유/);
    if (reason) await user.type(reason, "운영 확인");
    await user.type(
      within(dialog).getByLabelText(/확인 문구/),
      path.endsWith("retention") ? "데이터 정리" : "로그 재처리",
    );
    await user.click(within(dialog).getByRole("button", { name: confirm }));
  }
  await waitFor(() => expect(api.calls.some((call) => call.key === `POST ${path}`)).toBe(true));
  if (confirm) expect(api.bodies(`POST ${path}`)).toEqual([{ reason: "운영 확인" }]);
  expect(
    api.spy.mock.calls.some(
      ([endpoint, options]) =>
        endpoint.method === "POST" && endpoint.path === path && options?.retryUnauthorized === false,
    ),
  ).toBe(true);
});

it("떠난 화면의 늦은 재처리 완료 알림을 표시하지 않는다", async () => {
  let finish: (value: typeof replay) => void = () => undefined;
  const view = setup({
    "POST /admin/fallback": () =>
      new Promise<typeof replay>((resolve) => {
        finish = resolve;
      }),
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "DB로 재처리" }));
  await user.type(within(screen.getByRole("dialog")).getByLabelText(/확인 문구/), "로그 재처리");
  await user.type(within(screen.getByRole("dialog")).getByLabelText(/변경 사유/), "운영 확인");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "재처리 실행" }));
  await waitFor(() => expect(view.api.calls.some((call) => call.key === "POST /admin/fallback")).toBe(true));
  view.unmount();
  await act(async () => finish(replay));
  expect(notices.success).not.toHaveBeenCalled();
  expect(notices.error).not.toHaveBeenCalled();
});

it.each([
  ["지금 정리 실행", "정리 실행", "/admin/retention", "데이터 정리"],
  ["DB로 재처리", "재처리 실행", "/admin/fallback", "로그 재처리"],
  ["테스트 메시지 발송", "", "/admin/notifications/mattermost/test", ""],
])("%s 같은 틱 이중 클릭은 실행 요청 하나만 보낸다", async (open, confirm, path, target) => {
  let finish: (value: unknown) => void = () => undefined;
  const view = setup({
    [`POST ${path}`]: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const user = userEvent.setup();
  let button = screen.getByRole("button", { name: open });
  if (confirm) {
    await user.click(button);
    const dialog = within(screen.getByRole("dialog"));
    const reason = dialog.queryByLabelText(/변경 사유/);
    if (reason) await user.type(reason, "운영 확인");
    const phrase = dialog.queryByLabelText(/확인 문구/);
    if (phrase) await user.type(phrase, target);
    button = dialog.getByRole("button", { name: confirm });
  }
  act(() => {
    button.click();
    button.click();
  });
  await waitFor(() => expect(view.api.calls.filter((call) => call.key === `POST ${path}`)).toHaveLength(1));
  await act(async () =>
    finish(path.endsWith("fallback") ? replay : path.endsWith("retention") ? retention : { ok: true }),
  );
});

it.each([
  ["지금 정리 실행", "GET /admin/retention"],
  ["DB로 재처리", "GET /admin/fallback"],
])("%s는 상태 조회가 실패하면 실행하지 않는다", async (name, endpoint) => {
  setup({
    [endpoint]: () => {
      throw apiFailure("unavailable");
    },
  });
  await screen.findByText("요청 ID: req_test");
  expect(screen.getByRole("button", { name })).toBeDisabled();
});

it("정리 확인 후 상태 재조회는 이전 확인을 다시 사용하지 않는다", async () => {
  const view = setup();
  const user = userEvent.setup();
  await screen.findByText("/data/fallback.ndjson");
  await user.click(screen.getByRole("button", { name: "지금 정리 실행" }));
  const dialog = within(screen.getByRole("dialog"));
  await user.type(dialog.getByLabelText(/변경 사유/), "검토한 사유");
  await user.type(dialog.getByLabelText(/확인 문구/), "데이터 정리");
  expect(dialog.getByRole("button", { name: "정리 실행" })).toBeEnabled();
  await act(async () => {
    await view.client.invalidateQueries();
  });
  await waitFor(() => expect(dialog.getByRole("button", { name: "정리 실행" })).toBeDisabled());
  expect(dialog.getByLabelText(/변경 사유/)).toHaveValue("검토한 사유");
  expect(view.api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
});

it.each([
  ["지금 정리 실행", "정리 실행", "/admin/retention", "데이터 정리"],
  ["DB로 재처리", "재처리 실행", "/admin/fallback", "로그 재처리"],
])("%s 실패 응답 뒤 같은 확인으로 다시 전송하지 않는다", async (open, confirm, path, target) => {
  const view = setup({
    [`POST ${path}`]: () => {
      throw apiFailure("uncertain", 503);
    },
  });
  const user = userEvent.setup();
  await screen.findByText("/data/fallback.ndjson");
  await user.click(screen.getByRole("button", { name: open }));
  const dialog = within(screen.getByRole("dialog"));
  const reason = dialog.queryByLabelText(/변경 사유/);
  if (reason) await user.type(reason, "운영 확인");
  await user.type(dialog.getByLabelText(/확인 문구/), target);
  await user.click(dialog.getByRole("button", { name: confirm }));
  await dialog.findByRole("alert");
  expect(dialog.getByRole("button", { name: confirm })).toBeDisabled();
  await user.click(dialog.getByRole("button", { name: "취소" }));
  expect(screen.getByRole("button", { name: open })).toBeDisabled();
  expect(view.api.bodies(`POST ${path}`)).toHaveLength(1);
});
