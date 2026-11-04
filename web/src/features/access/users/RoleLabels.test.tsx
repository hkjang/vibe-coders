import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RolesTab as RolesTabScreen } from "@/features/access/users/RolesTab";
import { UsersTab as UsersTabScreen } from "@/features/access/users/UsersTab";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ role: "admin", scopes: ["admin:read", "admin:write"] }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const account = {
  id: "usr_role_label",
  email: "role-label@example.invalid",
  name: "역할 표시 검증",
  role: "ops_admin",
  status: "active",
  team_id: "",
  created_at: "2026-10-01T00:00:00Z",
};

function UsersTab() {
  return (
    <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: false }}>
      <UsersTabScreen canWrite writeDeniedReason="" />
    </FeatureAccessContext.Provider>
  );
}

function RolesTab({ canWrite, writeDeniedReason }: { canWrite: boolean; writeDeniedReason: string }) {
  return (
    <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: false }}>
      <RolesTabScreen canWrite={canWrite} writeDeniedReason={writeDeniedReason} />
    </FeatureAccessContext.Provider>
  );
}

function usersApi() {
  return mockApi({
    "GET /admin/users": () => ({ auth_users: [account], users: [], team_names: {} }),
    "GET /admin/benchmark/users": () => ({ users: [] }),
    "GET /admin/roles": () => ({
      roles: [
        "super_admin",
        "admin",
        "ops_admin",
        "ai_admin",
        "security_admin",
        "billing_admin",
        "team_admin",
        "team_manager",
        "developer",
        "service_account",
        "viewer",
        "readonly_admin",
      ].map((role) => ({ role })),
      all_scopes: [],
    }),
    "POST /admin/users": () => ({ user: account }),
    "PATCH /admin/users/usr_role_label": () => ({ user: account }),
  });
}

describe("사용자·역할 한글 표시", () => {
  it("등록 선택지를 한글로 표시하고 기존 역할 코드를 전송한다", async () => {
    const user = userEvent.setup();
    const api = usersApi();
    renderScreen(<UsersTab />);
    expect(await screen.findByText("운영 관리자")).toHaveAttribute("title", "ops_admin");
    await user.click(screen.getByRole("button", { name: "사용자 등록" }));
    const dialog = within(await screen.findByRole("dialog", { name: "사용자 등록" }));
    const role = dialog.getByRole("combobox", { name: "역할" });
    await waitFor(() => expect(within(role).getAllByRole("option")).toHaveLength(12));
    expect(
      within(role)
        .getAllByRole("option")
        .every((option) => /[가-힣]/u.test(option.textContent ?? "")),
    ).toBe(true);
    expect(role).toHaveValue("developer");
    await user.selectOptions(role, "운영 관리자");
    await user.type(dialog.getByLabelText("이메일", { exact: false }), "new-role@example.invalid");
    await user.type(dialog.getByLabelText("비밀번호", { exact: false }), "synthetic-password-only");
    await user.click(dialog.getByRole("button", { name: "등록" }));
    await waitFor(() => expect(api.bodies("POST /admin/users")).toHaveLength(1));
    expect(api.bodies("POST /admin/users")[0]).toMatchObject({ role: "ops_admin" });
  });

  it("수정 시 현재 한글 역할을 복원하고 변경한 코드만 기존 API로 보낸다", async () => {
    const user = userEvent.setup();
    const api = usersApi();
    renderScreen(<UsersTab />);
    const trigger = await screen.findByRole("button", { name: "역할·상태 변경" });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "사용자 변경" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger);
    const dialog = within(await screen.findByRole("dialog", { name: "사용자 변경" }));
    const role = dialog.getByRole("combobox", { name: "역할" });
    expect(role).toHaveValue("ops_admin");
    expect(await within(role).findByRole("option", { name: "운영 관리자" })).toHaveProperty("selected", true);
    await user.selectOptions(role, "조회자");
    await user.click(dialog.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(api.bodies("PATCH /admin/users/usr_role_label")).toEqual([
        { role: "viewer", status: "active", team_id: "" },
      ]),
    );
  });

  it("내장 역할은 한글명·코드를 함께 표시하고 사용자 정의 이름과 편집 권한을 보존한다", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /admin/roles": () => ({
        roles: [
          { role: "ops_admin", is_system: true, rank: 70, scopes: [], description: "", default_home: "" },
          {
            role: "custom_reviewer",
            is_system: false,
            rank: 0,
            scopes: [],
            description: "검토 담당",
            default_home: "",
          },
        ],
        all_scopes: [],
      }),
    });
    renderScreen(<RolesTab canWrite writeDeniedReason="" />);
    const builtIn = (await screen.findByText("운영 관리자")).closest("tr");
    expect(builtIn).not.toBeNull();
    if (!builtIn) throw new Error("내장 역할 행이 없습니다.");
    expect(within(builtIn).getByText("ops_admin")).toBeVisible();
    expect(within(builtIn).getByRole("button", { name: "수정" })).toBeDisabled();
    const custom = screen.getByText("custom_reviewer").closest("tr");
    expect(custom).not.toBeNull();
    if (!custom) throw new Error("사용자 정의 역할 행이 없습니다.");
    expect(within(custom).getByText("사용자 정의")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "권한 등급" })).toBeVisible();
    const trigger = within(custom).getByRole("button", { name: "수정" });
    await user.click(trigger);
    expect(
      within(await screen.findByRole("dialog", { name: "역할 수정" })).getByRole("textbox", {
        name: "역할 이름",
      }),
    ).toHaveValue("custom_reviewer");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
  });
});
