import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UsersPage } from "@/features/access/users/UsersPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ role: "admin", scopes: ["admin:read", "admin:write"] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ role: authRuntime.role, scopes: authRuntime.scopes }) };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const usersResponse = {
  users: [
    {
      api_key_id: "key_managed",
      name: "빌드 봇",
      owner: "platform",
      team: "platform",
      status: "active",
      requests: 1200,
      tokens: 340_000,
      cost_krw: 18_500,
      average_latency_ms: 420,
      last_seen: "2026-09-05T09:12:00Z",
    },
    {
      api_key_id: "key_external",
      name: "",
      owner: "",
      team: "",
      status: "external",
      requests: 40,
      tokens: 900,
      cost_krw: 120,
      average_latency_ms: 210,
      last_seen: "2026-09-04T02:00:00Z",
    },
  ],
  auth_users: [
    {
      id: "usr_1",
      email: "dev@example.com",
      name: "개발자",
      role: "developer",
      status: "active",
      team_id: "team_platform",
      created_at: "2026-01-02T00:00:00Z",
    },
    {
      id: "sso_2",
      email: "sso@example.com",
      name: "SSO 사용자",
      role: "viewer",
      status: "active",
      team_id: "",
      created_at: "2026-02-02T00:00:00Z",
    },
  ],
  team_names: { team_platform: "플랫폼" },
};

const emptyUsers = { users: [], auth_users: [], team_names: {} };
const benchmark = { users: [] };

function handlers(overrides: Record<string, () => unknown> = {}) {
  return {
    "GET /admin/users": () => usersResponse,
    "GET /admin/benchmark/users": () => benchmark,
    ...overrides,
  };
}

describe("UsersPage", () => {
  beforeEach(() => {
    authRuntime.role = "admin";
    authRuntime.scopes = ["admin:read", "admin:write"];
  });

  it("renders login accounts and proxy key usage", async () => {
    mockApi(handlers());
    renderScreen(<UsersPage />, { path: "/access/users/*", route: "/access/users" });

    expect(await screen.findByText("dev@example.com")).toBeVisible();
    expect(screen.getByText("플랫폼")).toBeVisible();
    expect(screen.getByText("빌드 봇")).toBeVisible();
    expect(screen.getByRole("button", { name: "관리 키로 등록" })).toBeVisible();
  });

  it("shows an empty state when nothing is registered yet", async () => {
    mockApi(handlers({ "GET /admin/users": () => emptyUsers }));
    renderScreen(<UsersPage />, { path: "/access/users/*", route: "/access/users" });

    expect(
      await screen.findByText("등록된 로그인 계정이 없습니다. '사용자 등록'으로 첫 계정을 만드세요."),
    ).toBeVisible();
  });

  it("surfaces the request id when the list fails", async () => {
    mockApi(
      handlers({
        "GET /admin/users": () => {
          throw apiFailure("boom", 500, "req_users_1");
        },
      }),
    );
    renderScreen(<UsersPage />, { path: "/access/users/*", route: "/access/users" });

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/req_users_1/u)).toBeVisible();
  });

  it("disables write actions without admin:write", async () => {
    authRuntime.role = "readonly_admin";
    authRuntime.scopes = ["admin:read"];
    mockApi(handlers());
    renderScreen(<UsersPage />, { path: "/access/users/*", route: "/access/users" });

    expect(await screen.findByRole("button", { name: "사용자 등록" })).toBeDisabled();
    expect(
      screen.getAllByText(
        "변경 권한(admin:write)이 없어 읽기만 할 수 있습니다. 관리자에게 권한을 요청하세요.",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("only allows editing usr_ accounts", async () => {
    mockApi(handlers());
    renderScreen(<UsersPage />, { path: "/access/users/*", route: "/access/users" });

    await screen.findByText("dev@example.com");
    const [managed, external] = screen.getAllByRole("button", { name: "역할·상태 변경" });
    expect(managed).toBeEnabled();
    expect(external).toBeDisabled();
  });

  it("patches only role, status and team when a user is edited", async () => {
    const user = userEvent.setup();
    const api = mockApi(handlers({ "PATCH /admin/users/usr_1": () => ({ user: null, team_id: "" }) }));
    renderScreen(<UsersPage />, { path: "/access/users/*", route: "/access/users" });

    await screen.findByText("dev@example.com");
    const [editButton] = screen.getAllByRole("button", { name: "역할·상태 변경" });
    await user.click(editButton as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("상태"), "disabled");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(api.bodies("PATCH /admin/users/usr_1")).toEqual([
        { role: "developer", status: "disabled", team_id: "team_platform" },
      ]);
    });
  });

  it("promotes an external key through the api-keys endpoint", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      handlers({ "PATCH /admin/api-keys/key_external": () => ({ id: "key_external", status: "active" }) }),
    );
    renderScreen(<UsersPage />, { path: "/access/users/*", route: "/access/users" });

    await user.click(await screen.findByRole("button", { name: "관리 키로 등록" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "등록" }));

    await waitFor(() => {
      expect(api.bodies("PATCH /admin/api-keys/key_external")).toEqual([
        { status: "active", name: "key_external", team: "" },
      ]);
    });
  });

  it("restores the selected tab from the URL", async () => {
    mockApi({
      ...handlers(),
      "GET /admin/ips": () => ({ ips: [{ ip: "10.0.0.5", requests: 12, distinct_keys: 2 }] }),
    });
    renderScreen(<UsersPage />, { path: "/access/users/*", route: "/access/users?tab=ips" });

    expect(await screen.findByText("IP 차단 기능은 서버에 없습니다.")).toBeVisible();
    expect(screen.getByRole("tab", { name: "IP" })).toHaveAttribute("aria-selected", "true");
  });

  it("creates a quota with the documented scope values", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...handlers(),
      "GET /admin/quotas": () => ({ quotas: [], usage: [] }),
      "GET /admin/budgets": () => ({ budgets: [] }),
      "POST /admin/quotas": () => ({ quota: { ID: "q1", Scope: "team", TokenLimit: 1000 } }),
    });
    renderScreen(<UsersPage />, { path: "/access/users/*", route: "/access/users?tab=quotas" });

    await user.click(await screen.findByRole("button", { name: "할당량 추가" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("대상"), "platform");
    await user.type(within(dialog).getByLabelText("토큰 한도"), "1000");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/quotas")).toEqual([
        {
          scope: "team",
          scope_value: "platform",
          period: "monthly",
          token_limit: 1000,
          enabled: true,
        },
      ]);
    });
  });

  it("has no automated accessibility violations", async () => {
    mockApi(handlers());
    const { container } = renderScreen(<UsersPage />, {
      path: "/access/users/*",
      route: "/access/users",
    });

    await screen.findByText("dev@example.com");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
