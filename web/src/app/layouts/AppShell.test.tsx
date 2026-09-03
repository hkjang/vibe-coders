import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    backendVersion: "v0.81.0",
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
    authRuntime.scopes = ["admin:read", "routing:read", "observability:read", "costs:read", "security:read"];
    usePreferences.setState({
      theme: "system",
      density: "default",
      refreshInterval: 0,
      sidebarCollapsed: false,
      mobileSidebarOpen: false,
      collapsedGroups: [],
    });
    vi.spyOn(apiClient, "request").mockResolvedValue({ status: "ok" });
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
