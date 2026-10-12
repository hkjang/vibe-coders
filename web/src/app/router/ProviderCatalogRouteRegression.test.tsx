import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoginPage } from "@/app/auth/LoginPage";
import { ProtectedRoute } from "@/app/guards/ProtectedRoute";
import { RouteQueryGuard } from "@/app/guards/RouteQueryGuard";
import { CommandPalette } from "@/app/layouts/CommandPalette";
import { CompatibilityRedirect } from "@/app/router/CompatibilityRedirect";
import { usePreferences } from "@/shared/stores/preferences";

const runtime = vi.hoisted(() => ({ mode: "authenticated" }));
const rendered = vi.hoisted(() => vi.fn());
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => ({ ...testAuth(), mode: runtime.mode }) };
});

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  const navigationType = useNavigationType();
  const value = location.pathname + location.search + location.hash;
  rendered(value);
  return <output data-navigation-type={navigationType}>{value}</output>;
}

function PaletteProbe(): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} onClick={() => setOpen(true)}>
        팔레트 열기
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} returnFocusRef={ref} />
      <LocationProbe />
    </>
  );
}

function routeTree(entry: string, palette = false): React.JSX.Element {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<RouteQueryGuard />}>
          <Route
            path="login"
            element={
              <>
                <LoginPage />
                <LocationProbe />
              </>
            }
          />
          <Route element={<ProtectedRoute />}>
            <Route path="providers" element={<CompatibilityRedirect to="/gateway/providers" />} />
            <Route path="gateway/providers" element={<LocationProbe />} />
            <Route path="gateway/models" element={palette ? <PaletteProbe /> : <LocationProbe />} />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("actual provider catalog guard, login and palette regression", () => {
  beforeEach(() => {
    runtime.mode = "authenticated";
    window.sessionStorage.clear();
    usePreferences.setState({ recentFeatures: [] });
  });

  it.each(["/gateway/providers", "/providers"])(
    "%s retains finite values through guard and compatibility redirect",
    async (path) => {
      render(
        routeTree(
          `${path}?sort=priority_desc&page_size=50&page=3&provider=managed-main&token=private#details`,
        ),
      );
      const expected =
        "/gateway/providers?sort=priority_desc&page_size=50&page=3&provider=managed-main#details";
      expect(await screen.findByRole("status")).toHaveTextContent(expected);
      expect(screen.getByRole("status")).toHaveAttribute("data-navigation-type", "REPLACE");
      expect(rendered.mock.calls.map(([value]) => value)).toEqual([expected]);
    },
  );

  it.each(["/gateway/providers", "/providers"])(
    "%s survives anonymous ProtectedRoute and authenticated LoginPage return",
    async (path) => {
      runtime.mode = "anonymous";
      const search = "?sort=timeout_asc&page_size=25&page=3&provider=managed-main";
      const entry = `${path}${search}&token=private#details`;
      const view = render(routeTree(entry));
      const location = await screen.findByRole("status");
      const loginURL = new URL(location.textContent ?? "", window.location.origin);
      expect(loginURL.pathname).toBe("/login");
      expect(loginURL.searchParams.get("return_to")).toBe(`/app${path}${search}#details`);
      runtime.mode = "authenticated";
      view.rerender(routeTree(entry));
      await waitFor(() => {
        expect(screen.getByRole("status")).toHaveTextContent(`/gateway/providers${search}#details`);
      });
      expect(screen.getByRole("status")).toHaveAttribute("data-navigation-type", "REPLACE");
      expect(rendered.mock.calls.every(([value]) => !String(value).includes("private"))).toBe(true);
    },
  );

  it("preserves the existing alias/filter/login round trip as a positive control", async () => {
    runtime.mode = "anonymous";
    const entry = "/providers?q=public&page=3&token=private#details";
    const view = render(routeTree(entry));
    const location = await screen.findByRole("status");
    const loginURL = new URL(location.textContent ?? "", window.location.origin);
    expect(loginURL.searchParams.get("return_to")).toBe("/app/providers?q=public&page=3#details");
    runtime.mode = "authenticated";
    view.rerender(routeTree(entry));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("/gateway/providers?q=public&page=3#details");
    });
  });

  it.each(["/gateway/providers", "/providers"])(
    "%s rejects ambiguous keys before any protected child sees them",
    async (path) => {
      render(routeTree(`${path}?sort=name_asc&sort=name_asc&page_size=25&page_size=50&page=3`));
      expect(await screen.findByRole("status")).toHaveTextContent("/gateway/providers?page=3");
      expect(rendered.mock.calls.map(([value]) => value)).toEqual(["/gateway/providers?page=3"]);
    },
  );

  it("keeps the real model guard contract unchanged as a positive control", async () => {
    render(routeTree("/gateway/models?sort=quality_desc&page_size=50&page=3&token=private"));
    const expected = "/gateway/models?sort=quality_desc&page_size=50&page=3";
    expect(await screen.findByRole("status")).toHaveTextContent(expected);
    expect(rendered.mock.calls.map(([value]) => value)).toEqual([expected]);
  });

  it("the actual palette opens the canonical provider route without inheriting model table state", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        {routeTree("/gateway/models?sort=quality_desc&page_size=50&page=3", true)}
      </QueryClientProvider>,
    );
    await user.type(await screen.findByRole("combobox", { name: "메뉴 검색" }), "AI 공급자");
    await user.click(screen.getByRole("option", { name: /AI 공급자/ }));
    expect(screen.queryByRole("dialog", { name: "명령 팔레트" })).not.toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(/^\/gateway\/providers$/);
    expect(screen.getByRole("status")).toHaveAttribute("data-navigation-type", "PUSH");
    view.unmount();
    client.clear();
  });
});
