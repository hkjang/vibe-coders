import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";

import { MeKeysTab } from "./MeKeysTab";
import { meKeys } from "./use-me-queries";
import { apiKeyPublicSchema } from "@/shared/api/domains/access.schemas";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { tokenStore } from "@/shared/auth/token-store";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { AppError } from "@/shared/api/error";

const identity = vi.hoisted(() => ({
  id: "owner-a",
  team: "team-a",
  role: "developer",
  scopes: ["models:read"],
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        role: identity.role,
        scopes: identity.scopes,
        user: { id: identity.id, team_id: identity.team },
      }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const runtime = { readOnly: false, permitted: true };
const row = apiKeyPublicSchema.parse({
  id: "key-reviewed",
  name: "검토용 키",
  user_id: "owner-a",
  team: "team-a",
  role: "developer",
  status: "active",
  scopes: ["models:read"],
  revision: "a".repeat(64),
});
const catalog = { api_keys: [row], role: "developer", grantable_scopes: ["models:read"] };
const result = {
  rotated_from: row.id,
  grace_ends_at: "2026-10-13T00:00:00Z",
  api_key: { id: "replacement" },
  secret: "vc_sk_synthetic_rotation_result",
};
const endpoint = "POST /me/keys/key-reviewed/rotate";

beforeEach(() => {
  Object.assign(identity, { id: "owner-a", team: "team-a", role: "developer", scopes: ["models:read"] });
  Object.assign(runtime, { readOnly: false, permitted: true });
  tokenStore.clearAll();
});

function setup(extra: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /me/keys": () => catalog,
    "GET /me/sessions": () => ({ sessions: [] }),
    [endpoint]: () => result,
    ...extra,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FeatureAccessContext.Provider value={{ featureId: "me.home", ...runtime }}>
          <MeKeysTab />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(tree()), tree, api, client };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("shows effective Korean key states and disables edits on expired keys", async () => {
  setup({
    "GET /me/keys": () => ({
      ...catalog,
      api_keys: [
        { ...row, id: "expired", name: "만료된 검사 키", expires_at: "2000-01-01T00:00:00Z" },
        {
          ...row,
          id: "retired",
          name: "유예가 끝난 검사 키",
          replaced_by: "next",
          grace_ends_at: "2000-01-01T00:00:00Z",
        },
        {
          ...row,
          id: "grace",
          name: "유예 중인 검사 키",
          replaced_by: "next-2",
          grace_ends_at: "2099-01-01T00:00:00Z",
        },
      ],
    }),
  });
  expect(await screen.findByText("개발자", { exact: true })).toBeVisible();
  for (const [name, state] of [
    ["만료된 검사 키", "만료"],
    ["유예가 끝난 검사 키", "유예 종료"],
    ["유예 중인 검사 키", "교체 유예 중"],
  ] as const) {
    const element = screen.getByText(name, { exact: true }).closest("li");
    if (!element) throw new Error("키 목록 항목이 없습니다.");
    const item = within(element);
    expect(item.getByText(state, { exact: true })).toBeVisible();
    expect(item.getByRole("button", { name: "권한 수정" })).toBeDisabled();
    expect(item.getByRole("button", { name: "회전" })).toBeDisabled();
  }
});

async function review(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "회전" }));
  const dialog = await screen.findByRole("dialog", { name: "키 회전" });
  await user.type(within(dialog).getByLabelText(/확인 문구/u), row.id);
  await user.type(within(dialog).getByLabelText(/변경 사유/u), "정기 교체");
  return dialog;
}

it("한글 유예 기간과 검토 revision을 전송하고 새 비밀값을 한 번만 표시한다", async () => {
  const user = userEvent.setup();
  const view = setup();
  const dialog = await review(user);
  expect(within(dialog).getByText(/사용 한도가 초기화되지 않으며/u)).toBeVisible();
  await user.selectOptions(within(dialog).getByLabelText(/이전 키 유예 기간/u), "3600");
  await user.click(within(dialog).getByRole("button", { name: "회전" }));
  expect(await screen.findByText(result.secret)).toBeVisible();
  expect(view.api.bodies(endpoint)).toEqual([
    { expected_revision: row.revision, reason: "정기 교체", grace_seconds: 3600 },
  ]);
  const submitted = view.api.spy.mock.calls.find(([api]) => api.path.endsWith("/rotate"));
  expect(submitted?.[1]).toMatchObject({ retryUnauthorized: false });
  await user.click(screen.getByRole("button", { name: "확인했습니다" }));
  expect(screen.queryByText(result.secret)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "회전" })).toBeDisabled();
});

it.each(["missing-revision", "expired", "retired", "revoked"])("%s 키는 회전할 수 없다", async (mode) => {
  const key = { ...row };
  if (mode === "missing-revision") key.revision = "";
  if (mode === "expired") key.expires_at = "2020-01-01T00:00:00Z";
  if (mode === "retired") key.replaced_by = "replacement";
  if (mode === "revoked") key.status = "revoked";
  const view = setup({ "GET /me/keys": () => ({ ...catalog, api_keys: [key] }) });
  expect(await screen.findByRole("button", { name: "회전" })).toBeDisabled();
  expect(view.api.bodies(endpoint)).toHaveLength(0);
});

it("필수 확인 문구와 사유 없이는 회전하지 않는다", async () => {
  const user = userEvent.setup();
  const view = setup();
  await user.click(await screen.findByRole("button", { name: "회전" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("button", { name: "회전" })).toBeDisabled();
  await user.type(within(dialog).getByLabelText(/확인 문구/u), "다른 키");
  await user.type(within(dialog).getByLabelText(/변경 사유/u), "정기 교체");
  expect(within(dialog).getByRole("button", { name: "회전" })).toBeDisabled();
  expect(view.api.bodies(endpoint)).toHaveLength(0);
});

it.each(["revision", "invalidated", "scopes"])("검토 중 %s 변경은 전송을 차단한다", async (change) => {
  const user = userEvent.setup();
  const view = setup();
  const dialog = await review(user);
  await act(async () => {
    if (change === "invalidated")
      await view.client.invalidateQueries({ queryKey: meKeys.keys, refetchType: "none" });
    else
      view.client.setQueriesData(
        { queryKey: meKeys.keys },
        change === "revision"
          ? { ...catalog, api_keys: [{ ...row, revision: "b".repeat(64) }] }
          : { ...catalog, grantable_scopes: [] },
      );
  });
  expect(within(dialog).getByRole("button", { name: "회전" })).toBeDisabled();
  expect(view.api.bodies(endpoint)).toHaveLength(0);
});

it("읽기 전용 전환은 초안을 유지하되 전송을 막는다", async () => {
  const user = userEvent.setup();
  const view = setup();
  const dialog = await review(user);
  runtime.readOnly = true;
  view.rerender(view.tree());
  expect(within(dialog).getByLabelText(/변경 사유/u)).toHaveValue("정기 교체");
  expect(within(dialog).getByRole("button", { name: "회전" })).toBeDisabled();
  expect(view.api.bodies(endpoint)).toHaveLength(0);
});

it("읽기 전용에서는 개인 키·세션·연결 진단 변경 버튼이 비활성화된다", async () => {
  runtime.readOnly = true;
  const view = setup({
    "GET /me/sessions": () => ({ sessions: [{ id: "current", current: true }, { id: "other" }] }),
  });
  await screen.findByRole("button", { name: "회전" });
  for (const name of ["키 발급", "권한 수정", "회전", "폐기", "다른 세션 모두 종료", "진단 실행"])
    expect(screen.getByRole("button", { name })).toBeDisabled();
  for (const button of screen.getAllByRole("button", { name: "종료" })) expect(button).toBeDisabled();
  expect(screen.getByRole("button", { name: "설정 불러오기" })).toBeEnabled();
  expect(view.api.bodies(endpoint)).toHaveLength(0);
});

it.each([
  ["키 발급", "키 발급", "발급", "POST /me/keys"],
  ["권한 수정", "내 API 키 권한 수정", "권한 저장", "PATCH /me/keys/key-reviewed"],
  ["폐기", "키 폐기", "폐기", "DELETE /me/keys/key-reviewed"],
  ["종료", "세션 종료", "종료", "DELETE /me/sessions/other"],
  ["다른 세션 모두 종료", "다른 세션 모두 종료", "모두 종료", "POST /me/sessions/revoke-others"],
])("%s 확인 중 읽기 전용이 되면 제출을 차단한다", async (trigger, title, submit, write) => {
  const user = userEvent.setup();
  const view = setup({
    "GET /me/sessions": () => ({ sessions: [{ id: "current", current: true }, { id: "other" }] }),
  });
  await screen.findByRole("button", { name: "회전" });
  const button = screen
    .getAllByRole("button", { name: trigger })
    .find((node) => !node.hasAttribute("disabled"));
  expect(button).toBeDefined();
  if (!button) throw new Error("변경 작업 버튼을 찾지 못했습니다.");
  await user.click(button);
  const dialog = await screen.findByRole("dialog", { name: title });
  if (trigger === "키 발급") await user.type(within(dialog).getByLabelText(/키 이름/u), "유지할 초안");
  runtime.readOnly = true;
  view.rerender(view.tree());
  expect(within(dialog).getByRole("button", { name: submit })).toBeDisabled();
  const form = dialog.querySelector("form");
  if (form) await act(async () => form.requestSubmit());
  expect(view.api.bodies(write)).toHaveLength(0);
  if (trigger === "키 발급") expect(within(dialog).getByLabelText(/키 이름/u)).toHaveValue("유지할 초안");
});

it.each([500])("회전 응답 %s 이후 자동 재요청과 같은 화면의 반복 회전을 막는다", async (status) => {
  const user = userEvent.setup();
  const view = setup({
    [endpoint]: () => {
      throw apiFailure("synthetic failure", status);
    },
  });
  const dialog = await review(user);
  await user.click(within(dialog).getByRole("button", { name: "회전" }));
  await waitFor(() => expect(within(dialog).getByRole("alert")).toBeVisible());
  expect(within(dialog).getByRole("button", { name: "회전" })).toBeDisabled();
  await user.click(within(dialog).getByRole("button", { name: "취소" }));
  expect(screen.getByRole("button", { name: "회전" })).toBeDisabled();
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: meKeys.keys });
  });
  expect(screen.getByRole("button", { name: "회전" })).toBeDisabled();
  expect(view.api.bodies(endpoint)).toHaveLength(1);
});

it("회전 실패 확인창은 도메인 오류 안내를 사용하고 서버 원문은 숨긴다", async () => {
  const user = userEvent.setup();
  setup({
    [endpoint]: () => {
      throw new AppError("SYNTHETIC_PRIVATE_SERVER_MESSAGE", {
        kind: "http",
        status: 409,
        code: "key_rotation_conflict",
        requestId: "req-rotation-conflict",
      });
    },
  });
  const dialog = await review(user);
  await user.click(within(dialog).getByRole("button", { name: "회전" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("최신 목록에서 다시 확인하세요.");
  expect(within(dialog).getByRole("alert")).toHaveTextContent("req-rotation-conflict");
  expect(screen.queryByText("SYNTHETIC_PRIVATE_SERVER_MESSAGE")).not.toBeInTheDocument();
});

it("권한 저장 폼과 알림은 개인 키 오류 문구를 사용한다", async () => {
  const user = userEvent.setup();
  const { toast } = await import("sonner");
  setup({
    "PATCH /me/keys/key-reviewed": () => {
      throw new AppError("SYNTHETIC_PRIVATE_SERVER_MESSAGE", {
        kind: "http",
        status: 409,
        code: "key_scopes_conflict",
        requestId: "req-scope-conflict",
      });
    },
  });
  await user.click(await screen.findByRole("button", { name: "권한 수정" }));
  const dialog = await screen.findByRole("dialog", { name: "내 API 키 권한 수정" });
  await user.click(within(dialog).getByRole("button", { name: "권한 저장" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("최신 목록에서 권한을 다시 검토하세요.");
  expect(toast.error).toHaveBeenCalledWith(
    "키 정보가 변경되었습니다. 최신 목록에서 권한을 다시 검토하세요.",
    {
      description: "요청 ID: req-scope-conflict",
    },
  );
  expect(screen.queryByText("SYNTHETIC_PRIVATE_SERVER_MESSAGE")).not.toBeInTheDocument();
});

it.each([401, 403])("회전 응답 %s 이후 이전 데이터와 작업을 잠근다", async (status) => {
  const user = userEvent.setup();
  const view = setup({
    [endpoint]: () => {
      throw apiFailure("synthetic failure", status);
    },
  });
  const dialog = await review(user);
  await user.click(within(dialog).getByRole("button", { name: "회전" }));
  expect(await screen.findByText(/데이터와 작업을 잠갔습니다/u)).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText(row.name)).not.toBeInTheDocument();
  expect(view.api.bodies(endpoint)).toHaveLength(1);
});

it.each(["id", "team", "role", "scopes", "epoch", "unmount"])(
  "%s 변경 뒤 늦은 비밀값을 표시하지 않는다",
  async (change) => {
    const user = userEvent.setup();
    const pending = deferred();
    const view = setup({ [endpoint]: () => pending.promise });
    const dialog = await review(user);
    await user.click(within(dialog).getByRole("button", { name: "회전" }));
    await waitFor(() => expect(view.api.bodies(endpoint)).toHaveLength(1));
    if (change === "unmount") view.unmount();
    else {
      if (change === "id") identity.id = "owner-b";
      if (change === "team") identity.team = "team-b";
      if (change === "role") identity.role = "viewer";
      if (change === "scopes") identity.scopes = [];
      if (change === "epoch") act(() => tokenStore.clearAll());
      view.rerender(view.tree());
    }
    await act(async () => {
      pending.resolve(result);
    });
    expect(screen.queryByText(result.secret)).not.toBeInTheDocument();
  },
);

it.each(["GET /me/keys", "GET /me/sessions"])(
  "%s 권한 거부는 이전 데이터와 확인창을 숨긴다",
  async (endpoint) => {
    const user = userEvent.setup();
    let denied = false;
    const view = setup({
      [endpoint]: () => {
        if (denied) throw apiFailure("denied", 403);
        return endpoint.endsWith("keys") ? catalog : { sessions: [] };
      },
    });
    await review(user);
    denied = true;
    await act(async () => {
      await view.client.invalidateQueries();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText(row.name)).not.toBeInTheDocument();
    expect(await screen.findByText(/데이터와 작업을 잠갔습니다/u)).toBeVisible();
  },
);
