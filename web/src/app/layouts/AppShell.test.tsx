import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/app/layouts/AppShell";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { usePreferences } from "@/shared/stores/preferences";

const authRuntime = vi.hoisted(() => ({
  uiEnabled: true,
  legacyFallback: true,
  scopes: ["admin:read", "routing:read", "observability:read", "costs:read", "security:read"],
}));

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: "authenticated",
    user: {
      id: "admin-1",
      email: "admin@example.test",
      name: "Admin",
      role: "admin",
      roles: ["admin"],
      team_id: "platform",
      scopes: authRuntime.scopes,
      features: {},
    },
    backendVersion: "v0.80.0",
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

function renderShell(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
    expect(screen.getByRole("option", { name: /Overview/ })).toHaveAttribute("aria-selected", "true");
    await user.type(search, "{ArrowDown}");
    expect(screen.getByRole("option", { name: /Provider/ })).toHaveAttribute("aria-selected", "true");
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
    expect(screen.getByRole("link", { name: "Legacy Admin 열기" })).toHaveAttribute("href", "/admin");
  });

  it("removes every optional Legacy entry point when runtime fallback is disabled", async () => {
    authRuntime.legacyFallback = false;
    const user = userEvent.setup();
    renderShell();
    expect(screen.queryByRole("link", { name: /Legacy/ })).not.toBeInTheDocument();
    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", { name: "명령 팔레트" })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Legacy Admin/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Provider/ })).not.toBeInTheDocument();
  });

  it("does not expose the Legacy Admin home to a user without effective admin permission", async () => {
    authRuntime.scopes = ["routing:read"];
    const user = userEvent.setup();
    renderShell();
    expect(document.querySelector('a[href="/admin"]')).not.toBeInTheDocument();
    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", { name: "명령 팔레트" })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Legacy Admin/ })).not.toBeInTheDocument();
  });

  it("has no automated axe accessibility violations in the application shell", async () => {
    const { container } = renderShell();
    await waitFor(() => expect(screen.getByText("Healthy")).toBeVisible());
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
  });

  it("does not repeat the page title when the breadcrumb group has the same name", () => {
    renderShell();
    const breadcrumb = screen.getByRole("navigation", { name: "현재 위치" });
    expect(within(breadcrumb).getAllByText("Overview")).toHaveLength(1);
  });
});
