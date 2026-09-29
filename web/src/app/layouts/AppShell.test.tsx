import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/app/layouts/AppShell";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { usePreferences } from "@/shared/stores/preferences";

const authRuntime = vi.hoisted(() => ({
  uiEnabled: true,
  legacyFallback: true,
  scopes: ["admin:read", "routing:read", "observability:read", "costs:read", "security:read"],
  role: "admin",
  backendVersion: "v0.81.0",
}));

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: "authenticated",
    user: {
      id: "admin-1",
      email: "admin@example.test",
      name: "Admin",
      role: authRuntime.role,
      roles: ["admin"],
      team_id: "platform",
      scopes: authRuntime.scopes,
      features: {},
    },
    backendVersion: authRuntime.backendVersion,
    uiVersion: "test",
    apiVersion: "v1",
    authenticationMode: "session",
    uiEnabled: authRuntime.uiEnabled,
    defaultEntry: "/app/overview",
    legacyFallback: authRuntime.legacyFallback,
    features: migrationRegistry,
    sso: { keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" },
    login: vi.fn(),
    logout: vi.fn(),
    retry: vi.fn(),
    setLegacyToken: vi.fn(),
  }),
}));

function renderShell(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/overview"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="overview" element={<h1>Overview content</h1>} />
            <Route path="gateway/providers" element={<h1>Provider content</h1>} />
            <Route path="agents/skills" element={<h1>Skill content</h1>} />
            <Route path="observability/requests" element={<h1>Request content</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppShell", () => {
  beforeEach(() => {
    authRuntime.uiEnabled = true;
    authRuntime.legacyFallback = true;
    authRuntime.role = "admin";
    authRuntime.backendVersion = "v0.81.0";
    authRuntime.scopes = ["admin:read", "routing:read", "observability:read", "costs:read", "security:read"];
    usePreferences.setState({
      theme: "system",
      density: "default",
      refreshInterval: 0,
      sidebarCollapsed: false,
      mobileSidebarOpen: false,
      collapsedGroups: [],
      recentFeatures: [],
    });
    vi.spyOn(apiClient, "request").mockResolvedValue({ status: "ok" });
  });

  it("shows Korean feature names while preserving paths and English search keywords", async () => {
    const user = userEvent.setup();
    renderShell();

    for (const [name, path] of [
      ["채팅 테스트", "/gateway/chat"],
      ["게이트웨이 MCP", "/mcp-gateway"],
      ["스킬", "/agents/skills"],
      ["레드팀 자동화", "/redteam"],
    ]) {
      expect(screen.getByRole("link", { name: new RegExp(`^${name}`) })).toHaveAttribute("href", path);
    }

    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByRole("combobox", { name: "메뉴 검색" }), "skill");
    await user.click(screen.getByRole("option", { name: /스킬/ }));
    expect(screen.getByRole("heading", { name: "Skill content" })).toBeVisible();
  });

  it("uses the complete combobox/listbox keyboard model to navigate by command", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", { name: "명령 팔레트" })).toBeVisible();
    const search = screen.getByRole("combobox", { name: "메뉴 검색" });
    expect(screen.getByRole("option", { name: /통합 현황/ })).toHaveAttribute("aria-selected", "true");
    await user.type(search, "AI 게이트웨이");
    expect(screen.getByRole("option", { name: /게이트웨이 상태/ })).toHaveAttribute("aria-selected", "true");
    await user.type(search, "{ArrowDown}");
    expect(screen.getByRole("option", { name: /AI 공급자/ })).toHaveAttribute("aria-selected", "true");
    await user.type(search, "{Enter}");
    expect(screen.getByRole("heading", { name: "Provider content" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "명령 팔레트" })).not.toBeInTheDocument();
  });

  it("runs a setting from the palette instead of making the operator find its menu", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("combobox", { name: "메뉴 검색" });

    await user.type(search, "테마");
    const themeCommand = screen.getByRole("option", { name: /테마 전환/ });
    expect(themeCommand).toHaveAttribute("aria-selected", "true");
    await user.click(themeCommand);

    expect(usePreferences.getState().theme).toBe("dark");
    expect(screen.queryByRole("dialog", { name: "명령 팔레트" })).not.toBeInTheDocument();
  });

  it("offers a pasted request id as a jump, and refuses a pasted credential", async () => {
    authRuntime.backendVersion = "v0.86.3";
    const user = userEvent.setup();
    renderShell();
    await user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("combobox", { name: "메뉴 검색" });

    await user.type(search, "req_01JABCDEF");
    expect(screen.getByRole("option", { name: /요청 ID로 이동/ })).toHaveAttribute("aria-selected", "true");

    await user.clear(search);
    await user.type(search, `sk-ant-${"a".repeat(40)}`);
    expect(screen.queryByRole("option", { name: /ID로 이동/ })).not.toBeInTheDocument();
  });

  it.each(["forbidden", "legacy"])("does not offer ID jumps for a %s request explorer", async (mode) => {
    authRuntime.backendVersion = mode === "legacy" ? "v0.81.0" : "v0.86.3";
    if (mode === "forbidden") authRuntime.scopes = ["routing:read"];
    const user = userEvent.setup();
    renderShell();
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByRole("combobox", { name: "메뉴 검색" }), "req_01JABCDEF");
    expect(screen.queryByRole("option", { name: /ID로 이동/ })).not.toBeInTheDocument();
    expect(screen.getByText("검색 결과가 없습니다.")).toBeVisible();
  });

  it("keeps IME confirmation, candidate movement and Escape inside the composing search", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: "명령 팔레트 열기" }));
    const search = await screen.findByRole("combobox", { name: "메뉴 검색" });
    await user.type(search, "AI 게이트웨이");
    const first = screen.getByRole("option", { name: /게이트웨이 상태/ });
    fireEvent.compositionStart(search);
    for (const key of ["ArrowDown", "End", "Home", "Enter", "Escape"]) fireEvent.keyDown(search, { key });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("dialog", { name: "명령 팔레트" })).toBeVisible();
    fireEvent.compositionEnd(search);
    fireEvent.keyDown(search, { key: "Enter", isComposing: true });
    fireEvent.keyDown(search, { key: "Enter", keyCode: 229 });
    expect(screen.getByRole("dialog", { name: "명령 팔레트" })).toBeVisible();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("heading", { name: "Provider content" })).toBeVisible();
    expect(document.querySelector("#main-content")).toHaveFocus();
  });

  it("restores the trigger after Escape, including a repeated shortcut while already open", async () => {
    const user = userEvent.setup();
    renderShell();
    const trigger = screen.getByRole("button", { name: "명령 팔레트 열기" });
    await user.click(trigger);
    await screen.findByRole("combobox", { name: "메뉴 검색" });
    await user.keyboard("{Control>}k{/Control}{Escape}");
    expect(trigger).toHaveFocus();
    trigger.focus();
    await user.keyboard("{Control>}k{/Control}{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("offers an accessible empty-state reset without reading or storing the search text", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("combobox", { name: "메뉴 검색" });
    await user.type(search, "없는 메뉴 검색어");
    expect(screen.getByRole("status")).toHaveTextContent("검색 결과 0개");
    expect((await axe.run(document.body)).violations).toEqual([]);
    await user.click(screen.getByRole("button", { name: "검색어 지우기" }));
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    expect(localStorage.getItem("vibe.app.preferences.v1") ?? "").not.toContain("없는 메뉴 검색어");
  });

  it("keeps focus in the shortcut dialog opened by a palette command", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: "명령 팔레트 열기" }));
    await user.type(await screen.findByRole("combobox", { name: "메뉴 검색" }), "단축키");
    await user.keyboard("{Enter}");
    const help = await screen.findByRole("dialog", { name: "단축키" });
    await waitFor(() => expect(help.contains(document.activeElement)).toBe(true));
    await user.keyboard("{Tab}");
    expect(screen.getByRole("region", { name: "단축키 안내 내용" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "단축키" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "명령 팔레트 열기" })).toHaveFocus();
    await user.keyboard("?");
    expect(await screen.findByRole("dialog", { name: "단축키" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "명령 팔레트 열기" })).toHaveFocus();
  });

  it("offers the screens just visited before the rest of the menu", async () => {
    usePreferences.setState({ recentFeatures: ["gateway.providers"] });
    const user = userEvent.setup();
    renderShell();
    await user.keyboard("{Control>}k{/Control}");

    const options = await screen.findAllByRole("option");
    // The screen being viewed is the most recent one, then the previously seeded visit.
    expect(options[0]).toHaveAccessibleName(/통합 현황.*최근/);
    expect(options[1]).toHaveAccessibleName(/AI 공급자.*최근/);
    expect(usePreferences.getState().recentFeatures.slice(0, 2)).toEqual(["overview", "gateway.providers"]);
  });

  it("documents the keyboard with ? and keeps it out of the way while typing", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.keyboard("?");
    expect(await screen.findByRole("dialog", { name: "단축키" })).toBeVisible();
    expect((await axe.run(document.body)).violations).toEqual([]);
    await user.keyboard("{Escape}");

    // Typing "?" into a field is a question mark, not a shortcut.
    await user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("combobox", { name: "메뉴 검색" });
    await user.type(search, "?");
    expect(screen.queryByRole("dialog", { name: "단축키" })).not.toBeInTheDocument();
  });

  it("traps focus in the mobile navigation dialog and restores it after Escape", async () => {
    const user = userEvent.setup();
    renderShell();
    const trigger = screen.getByRole("button", { name: "탐색 메뉴 열기" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "주 메뉴" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "주 메뉴" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("provides the Legacy Admin action inside the user menu", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByLabelText("사용자 메뉴"));
    expect(screen.getByRole("link", { name: "기존 관리자 화면 열기" })).toHaveAttribute("href", "/admin");
    expect(screen.getByText("역할: 관리자")).toBeVisible();
  });

  it("does not expose an unknown role code in the user menu", async () => {
    authRuntime.role = "unexpected_private_role";
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByLabelText("사용자 메뉴"));
    expect(screen.getByText("역할: 확인 불가")).toBeVisible();
    expect(screen.queryByText(/unexpected_private_role/)).not.toBeInTheDocument();
  });

  it("removes every optional Legacy entry point when runtime fallback is disabled", async () => {
    authRuntime.legacyFallback = false;
    const user = userEvent.setup();
    renderShell();
    expect(screen.queryByRole("link", { name: /기존 화면/ })).not.toBeInTheDocument();
    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", { name: "명령 팔레트" })).toBeVisible();
    expect(screen.queryByRole("link", { name: /기존 관리자 화면/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /AI 공급자/ })).not.toBeInTheDocument();
  });

  it("does not expose the Legacy Admin home to a user without effective admin permission", async () => {
    authRuntime.scopes = ["routing:read"];
    const user = userEvent.setup();
    renderShell();
    expect(document.querySelector('a[href="/admin"]')).not.toBeInTheDocument();
    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", { name: "명령 팔레트" })).toBeVisible();
    expect(screen.queryByRole("link", { name: /기존 관리자 화면/ })).not.toBeInTheDocument();
  });

  it("has no automated axe accessibility violations in the application shell", async () => {
    const { container } = renderShell();
    await waitFor(() => expect(screen.getByText("정상")).toBeVisible());
    const result = await axe.run(container);
    expect(result.violations).toEqual([]);
  });

  it("marks a cached health response as degraded when its refresh fails", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["gateway", "health"], { status: "ok" }, { updatedAt: Date.now() - 20_000 });
    vi.mocked(apiClient.request).mockRejectedValueOnce(
      new AppError("Gateway 상태를 갱신할 수 없습니다.", { kind: "network" }),
    );

    renderShell(client);

    expect(await screen.findByText("저하")).toBeVisible();
    expect(screen.queryByText("정상")).not.toBeInTheDocument();
    expect(screen.queryByText("연결 끊김")).not.toBeInTheDocument();
  });

  it("does not repeat the page title when the breadcrumb group has the same name", () => {
    renderShell();
    const breadcrumb = screen.getByRole("navigation", { name: "현재 위치" });
    expect(within(breadcrumb).getAllByText("통합 현황")).toHaveLength(1);
  });
});
