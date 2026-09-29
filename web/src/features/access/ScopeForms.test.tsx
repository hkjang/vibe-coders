import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MeKeysTab } from "@/features/access/me/MeKeysTab";
import { ApiKeysTab } from "@/features/access/users/ApiKeysTab";
import { RolesTab } from "@/features/access/users/RolesTab";
import { publishLogout } from "@/shared/auth/token-store";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ role: "admin", scopes: ["admin:read", "admin:write"] }) };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const scopeOptions = ["chat:completion", "models:read"];
const roles = {
  roles: [
    {
      role: "reviewer",
      // A scope missing from all_scopes must survive editing another checkbox.
      scopes: ["models:read", "future:scope", "chat:completion"],
      default_home: "",
      is_admin: false,
      is_system: false,
      rank: 0,
      description: "검토자",
    },
  ],
  all_scopes: scopeOptions,
};
const readHandlers: Record<string, ApiHandler> = {
  "GET /admin/roles": () => roles,
  "GET /admin/api-keys": () => ({ api_keys: [] }),
  "GET /me/keys": () => ({ api_keys: [], role: "developer", grantable_scopes: scopeOptions }),
  "GET /me/sessions": () => ({ current_session_id: "", sessions: [] }),
};
const forms = [
  {
    name: "역할 추가",
    trigger: "역할 추가",
    render: () => <RolesTab canWrite writeDeniedReason="" />,
    nameField: "역할 이름",
    submit: "저장",
    endpoint: "POST /admin/roles",
    body: { role: "scope_test" },
    emptyBody: { role: "scope_test", scopes: [] },
    result: { role: "scope_test", scopes: [] },
  },
  {
    name: "API 키 발급",
    trigger: "키 발급",
    render: () => <ApiKeysTab canWrite isSuperAdmin writeDeniedReason="" />,
    nameField: "이름",
    submit: "발급",
    endpoint: "POST /admin/api-keys",
    body: { name: "scope_test" },
    emptyBody: { name: "scope_test" },
    result: { api_key: { id: "key_new" }, secret: "test-issued-key" },
  },
  {
    name: "키 발급",
    trigger: "키 발급",
    render: () => <MeKeysTab />,
    nameField: "키 이름",
    submit: "발급",
    endpoint: "POST /me/keys",
    body: { name: "scope_test" },
    emptyBody: { name: "scope_test" },
    result: { api_key: { id: "key_new" }, secret: "test-issued-key" },
  },
] as const;

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe.each(forms)("$name 스코프 폼", (fixture) => {
  it("스코프만 바꿔도 닫기를 보호하고 원복하면 경고 없이 닫는다", async () => {
    const user = userEvent.setup();
    const api = mockApi(readHandlers);
    renderScreen(fixture.render());
    await user.click(await screen.findByRole("button", { name: fixture.trigger }));
    const dialog = await screen.findByRole("dialog", { name: fixture.name });
    await user.click(within(dialog).getByRole("checkbox", { name: "chat:completion" }));
    await user.keyboard("{Escape}");
    const guard = await screen.findByRole("alertdialog");
    await user.click(within(guard).getByRole("button", { name: "계속 편집" }));
    expect(within(dialog).getByRole("checkbox", { name: "chat:completion" })).toBeChecked();
    await user.click(within(dialog).getByRole("checkbox", { name: "chat:completion" }));
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);

    await user.click(screen.getByRole("button", { name: fixture.trigger }));
    const reopened = await screen.findByRole("dialog", { name: fixture.name });
    await user.click(within(reopened).getByRole("checkbox", { name: "models:read" }));
    await user.click(within(reopened).getByRole("button", { name: "취소" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
    );
    await user.click(screen.getByRole("button", { name: fixture.trigger }));
    expect(
      within(await screen.findByRole("dialog", { name: fixture.name })).getByRole("checkbox", {
        name: "models:read",
      }),
    ).not.toBeChecked();
  });

  it("빈 스코프의 기존 생략 또는 명시 배열 계약을 유지한다", async () => {
    const user = userEvent.setup();
    const api = mockApi({ ...readHandlers, [fixture.endpoint]: () => fixture.result });
    renderScreen(fixture.render());
    await user.click(await screen.findByRole("button", { name: fixture.trigger }));
    const dialog = await screen.findByRole("dialog", { name: fixture.name });
    await user.type(within(dialog).getByRole("textbox", { name: fixture.nameField }), "scope_test");
    await user.click(within(dialog).getByRole("checkbox", { name: "chat:completion" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "chat:completion" }));
    await user.click(within(dialog).getByRole("button", { name: fixture.submit }));
    await waitFor(() => expect(api.bodies(fixture.endpoint)).toEqual([fixture.emptyBody]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: fixture.name })).not.toBeInTheDocument());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("제출 스냅샷을 고정하고 대기 중 스코프와 중복 저장을 잠그며 실패 후 초안을 유지한다", async () => {
    const user = userEvent.setup();
    const first = deferred();
    let requests = 0;
    const api = mockApi({
      ...readHandlers,
      [fixture.endpoint]: () => (++requests === 1 ? first.promise : fixture.result),
    });
    renderScreen(fixture.render());
    await user.click(await screen.findByRole("button", { name: fixture.trigger }));
    const dialog = await screen.findByRole("dialog", { name: fixture.name });
    await user.type(within(dialog).getByRole("textbox", { name: fixture.nameField }), "scope_test");
    await user.click(within(dialog).getByRole("checkbox", { name: "models:read" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "chat:completion" }));
    await user.click(within(dialog).getByRole("button", { name: fixture.submit }));
    const snapshot = { ...fixture.body, scopes: ["chat:completion", "models:read"] };
    await waitFor(() => expect(api.bodies(fixture.endpoint)).toEqual([snapshot]));
    expect(within(dialog).getByRole("textbox", { name: fixture.nameField })).toBeDisabled();
    const checkbox = within(dialog).getByRole("checkbox", { name: "chat:completion" });
    expect(checkbox).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled();
    await user.click(checkbox);
    await user.click(within(dialog).getByRole("button", { name: "저장 중" }));
    await user.keyboard("{Escape}");
    expect(checkbox).toBeChecked();
    expect(api.bodies(fixture.endpoint)).toEqual([snapshot]);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await act(async () => first.reject(apiFailure("save failed", 500, "req_scope_save")));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("req_scope_save");
    expect(checkbox).toBeEnabled();
    expect(checkbox).toBeChecked();
    await user.keyboard("{Escape}");
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "계속 편집" }),
    );
    await user.click(checkbox);
    await user.click(within(dialog).getByRole("button", { name: fixture.submit }));
    await waitFor(() =>
      expect(api.bodies(fixture.endpoint)).toEqual([snapshot, { ...fixture.body, scopes: ["models:read"] }]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: fixture.name })).not.toBeInTheDocument());
  });

  it("보안 폐기 후 늦은 저장 결과가 다시 연 폼을 닫거나 이전 키 비밀값을 표시하지 않는다", async () => {
    const user = userEvent.setup();
    const first = deferred();
    const api = mockApi({ ...readHandlers, [fixture.endpoint]: () => first.promise });
    renderScreen(fixture.render());
    await user.click(await screen.findByRole("button", { name: fixture.trigger }));
    const dialog = await screen.findByRole("dialog", { name: fixture.name });
    await user.type(within(dialog).getByRole("textbox", { name: fixture.nameField }), "scope_test");
    await user.click(within(dialog).getByRole("checkbox", { name: "chat:completion" }));
    await user.click(within(dialog).getByRole("button", { name: fixture.submit }));
    await waitFor(() =>
      expect(api.bodies(fixture.endpoint)).toEqual([{ ...fixture.body, scopes: ["chat:completion"] }]),
    );

    // Exercise the real security disposal event while retaining this mounted
    // screen instance. Full login/remount behavior belongs to auth/browser tests.
    act(() => publishLogout());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: fixture.trigger }));
    const reopened = await screen.findByRole("dialog", { name: fixture.name });
    const name = within(reopened).getByRole("textbox", { name: fixture.nameField });
    const scope = within(reopened).getByRole("checkbox", { name: "models:read" });
    expect(name).toHaveValue("");
    expect(name).toBeDisabled();
    expect(scope).toBeDisabled();
    expect(scope).not.toBeChecked();
    await act(async () => first.resolve(fixture.result));
    await waitFor(() => expect(name).toBeEnabled());
    expect(reopened).toBeVisible();
    expect(scope).toBeEnabled();
    expect(within(reopened).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("test-issued-key")).not.toBeInTheDocument();
    await user.type(name, "fresh_draft");
    await user.click(scope);
    await user.keyboard("{Escape}");
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "계속 편집" }),
    );
    expect(name).toHaveValue("fresh_draft");
    expect(scope).toBeChecked();
    expect(api.bodies(fixture.endpoint)).toHaveLength(1);
  });
});

describe("역할 스코프 편집", () => {
  it("기존 scope 순서와 무관하게 원복을 인식하고 목록 밖 scope를 보존한다", async () => {
    const user = userEvent.setup();
    const api = mockApi({ ...readHandlers, "POST /admin/roles": () => ({ role: "reviewer" }) });
    renderScreen(<RolesTab canWrite writeDeniedReason="" />);
    await user.click(await screen.findByRole("button", { name: "수정" }));
    let dialog = await screen.findByRole("dialog", { name: "역할 수정" });
    await user.click(within(dialog).getByRole("checkbox", { name: "chat:completion" }));
    await user.keyboard("{Escape}");
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "계속 편집" }),
    );
    await user.click(within(dialog).getByRole("checkbox", { name: "chat:completion" }));
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.bodies("POST /admin/roles")).toEqual([]);

    await user.click(screen.getByRole("button", { name: "수정" }));
    dialog = await screen.findByRole("dialog", { name: "역할 수정" });
    await user.click(within(dialog).getByRole("checkbox", { name: "models:read" }));
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(api.bodies("POST /admin/roles")).toEqual([
        { role: "reviewer", description: "검토자", scopes: ["chat:completion", "future:scope"] },
      ]),
    );
    expect(roles.roles[0]?.scopes).toEqual(["models:read", "future:scope", "chat:completion"]);
  });
});
