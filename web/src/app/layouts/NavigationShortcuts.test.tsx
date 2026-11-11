import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { migrationRegistry, type MigrationFeature } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { usePreferences } from "@/shared/stores/preferences";

const runtime = vi.hoisted(() => ({ scopes: ["admin:read", "costs:read"], hidden: false, legacy: false }));
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: "authenticated",
    user: {
      id: "reader",
      name: "조회 사용자",
      role: "admin",
      roles: ["admin"],
      scopes: runtime.scopes,
      features: {},
      team_id: "test-team",
    },
    backendVersion: "v0.86.63",
    uiVersion: "test",
    apiVersion: "v1",
    legacyFallback: true,
    features: migrationRegistry.map((feature): MigrationFeature =>
      feature.featureId === "gateway.providers"
        ? { ...feature, status: runtime.hidden ? "hidden" : runtime.legacy ? "legacy" : feature.status }
        : feature,
    ),
    logout: vi.fn(),
  }),
}));

function Shell() {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/overview"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="overview" element={<h1>현황 본문</h1>} />
            <Route path="gateway/providers" element={<h1>공급자 본문</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  runtime.scopes = ["admin:read", "costs:read"];
  runtime.hidden = false;
  runtime.legacy = false;
  usePreferences.setState({
    favoriteFeatures: [],
    recentFeatures: [],
    collapsedGroups: [],
    sidebarCollapsed: false,
    mobileSidebarOpen: false,
  });
  vi.spyOn(apiClient, "request").mockResolvedValue({ status: "ok" });
});

describe("navigation shortcuts", () => {
  it("pins the current screen above menu groups and removes it without navigating", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    await user.click(screen.getByRole("button", { name: "통합 현황 즐겨찾기에 추가" }));
    const favorites = screen.getByRole("list", { name: "즐겨찾기" });
    expect(within(favorites).getByRole("link", { name: /통합 현황/ })).toHaveAttribute("href", "/overview");
    expect(screen.getByRole("button", { name: "통합 현황 즐겨찾기 해제" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("heading", { name: "현황 본문" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "통합 현황 즐겨찾기 해제" }));
    expect(screen.queryByRole("list", { name: "즐겨찾기" })).not.toBeInTheDocument();
  });

  it("persists only menu ids and restores order through hydration", async () => {
    const user = userEvent.setup();
    const view = render(<Shell />);
    await user.click(screen.getByRole("button", { name: "통합 현황 즐겨찾기에 추가" }));
    await user.click(screen.getByRole("link", { name: /^AI 공급자/ }));
    await user.click(screen.getByRole("button", { name: "AI 공급자 즐겨찾기에 추가" }));
    const stored = localStorage.getItem("vibe.app.preferences.v1");
    if (!stored) throw new Error("표시 설정이 저장되지 않았습니다.");
    expect(JSON.parse(stored).state.favoriteFeatures).toEqual(["overview", "gateway.providers"]);
    expect(stored).not.toContain("/gateway/providers");
    expect(stored).not.toContain("test-team");
    view.unmount();
    usePreferences.setState({ favoriteFeatures: [] });
    localStorage.setItem("vibe.app.preferences.v1", stored);
    await act(() => usePreferences.persist.rehydrate());
    render(<Shell />);
    expect(
      within(screen.getByRole("list", { name: "즐겨찾기" }))
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/overview", "/gateway/providers"]);
  });

  it("reorders and removes favorites with keyboard focus and returns to its trigger", async () => {
    usePreferences.setState({ favoriteFeatures: ["overview", "gateway.providers"] });
    const user = userEvent.setup();
    render(<Shell />);
    const trigger = screen.getByRole("button", { name: "즐겨찾기 관리" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "즐겨찾기 관리" });
    const up = within(dialog).getByRole("button", { name: "AI 공급자 위로 이동" });
    up.focus();
    await user.keyboard("{Enter}");
    expect(usePreferences.getState().favoriteFeatures).toEqual(["gateway.providers", "overview"]);
    expect(within(dialog).getByText("AI 공급자", { exact: true })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "AI 공급자 즐겨찾기 해제" }));
    expect(within(dialog).getByText("통합 현황", { exact: true })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "즐겨찾기 전체 해제" }));
    expect(within(dialog).getByRole("button", { name: "완료" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(usePreferences.getState().favoriteFeatures).toEqual([]);
  });

  it("offers favorites first in the palette without duplicating recent destinations", async () => {
    usePreferences.setState({
      favoriteFeatures: ["gateway.providers", "overview"],
      recentFeatures: ["gateway.providers"],
    });
    const user = userEvent.setup();
    render(<Shell />);
    await user.keyboard("{Control>}k{/Control}");
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent("AI 공급자");
    expect(options[0]).toHaveTextContent("즐겨찾기");
    expect(screen.getAllByRole("option", { name: /AI 공급자/ })).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "공급자 본문" })).toBeVisible();
  });

  it.each(["permission", "hidden"])(
    "removes unavailable shortcuts immediately after %s changes",
    async (mode) => {
      usePreferences.setState({
        favoriteFeatures: ["gateway.providers"],
        recentFeatures: ["gateway.providers"],
      });
      const user = userEvent.setup();
      const view = render(<Shell />);
      await user.click(screen.getByRole("button", { name: "즐겨찾기 관리" }));
      expect(await screen.findByRole("dialog", { name: "즐겨찾기 관리" })).toHaveTextContent("AI 공급자");
      if (mode === "permission") runtime.scopes = ["costs:read"];
      else runtime.hidden = true;
      view.rerender(<Shell />);
      expect(screen.getByRole("dialog", { name: "즐겨찾기 관리" })).not.toHaveTextContent("AI 공급자");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("list", { name: "즐겨찾기" })).not.toBeInTheDocument();
      await user.click(screen.getByLabelText("사용자 메뉴"));
      expect(screen.getByRole("region", { name: "최근 방문 화면" })).not.toHaveTextContent("AI 공급자");
      await user.keyboard("{Control>}k{/Control}");
      expect(screen.queryByRole("option", { name: /AI 공급자/ })).not.toBeInTheDocument();
    },
  );

  it("preserves the legacy bridge and migration label in pinned menus", () => {
    runtime.legacy = true;
    usePreferences.setState({ favoriteFeatures: ["gateway.providers"] });
    render(<Shell />);
    const link = within(screen.getByRole("list", { name: "즐겨찾기" })).getByRole("link", {
      name: /AI 공급자/,
    });
    expect(link).toHaveAttribute("href", "/gateway/providers");
    expect(link).toHaveTextContent("기존 화면");
  });

  it("opens recent screens from the user menu, closes it and clears history", async () => {
    usePreferences.setState({ recentFeatures: ["gateway.providers"] });
    const user = userEvent.setup();
    render(<Shell />);
    await user.click(screen.getByLabelText("사용자 메뉴"));
    const region = screen.getByRole("region", { name: "최근 방문 화면" });
    await user.click(within(region).getByRole("link", { name: "AI 공급자" }));
    expect(screen.getByRole("heading", { name: "공급자 본문" })).toBeVisible();
    expect(screen.getByLabelText("사용자 메뉴").closest("details")).not.toHaveAttribute("open");
    await user.click(screen.getByLabelText("사용자 메뉴"));
    await user.click(screen.getByRole("button", { name: "최근 화면 기록 지우기" }));
    expect(screen.getByText("최근 방문한 화면이 없습니다.")).toBeVisible();
    expect(usePreferences.getState().recentFeatures).toEqual([]);
    expect(screen.getByRole("heading", { name: "최근 방문 화면" })).toHaveFocus();
  });
});
