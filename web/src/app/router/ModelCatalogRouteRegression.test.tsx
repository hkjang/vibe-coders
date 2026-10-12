import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoginPage } from "@/app/auth/LoginPage";
import { ProtectedRoute } from "@/app/guards/ProtectedRoute";
import { RouteQueryGuard } from "@/app/guards/RouteQueryGuard";
import { CompatibilityRedirect } from "@/app/router/CompatibilityRedirect";

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

function routeTree(entry: string): React.JSX.Element {
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
            <Route path="models" element={<CompatibilityRedirect to="/gateway/models" />} />
            <Route path="gateway/models" element={<LocationProbe />} />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("actual model catalog guard and login route regression", () => {
  beforeEach(() => {
    runtime.mode = "authenticated";
    window.sessionStorage.clear();
  });

  it.each(["/gateway/models", "/models"])(
    "%s keeps the finite query through guard and compatibility redirect",
    async (path) => {
      render(
        routeTree(
          `${path}?sort=quality_desc&page_size=50&page=3&model=gpt-test&model_provider=openai&token=private#details`,
        ),
      );
      const expected =
        "/gateway/models?sort=quality_desc&page_size=50&page=3&model=gpt-test&model_provider=openai#details";
      expect(await screen.findByRole("status")).toHaveTextContent(expected);
      expect(screen.getByRole("status")).toHaveAttribute("data-navigation-type", "REPLACE");
      expect(rendered.mock.calls.map(([value]) => value)).toEqual([expected]);
    },
  );

  it.each(["/gateway/models", "/models"])(
    "%s survives actual anonymous ProtectedRoute and authenticated LoginPage return",
    async (path) => {
      runtime.mode = "anonymous";
      const search = "?sort=success_asc&page_size=25&page=3&model=gpt-test&model_provider=openai";
      const entry = `${path}${search}&token=private#details`;
      const view = render(routeTree(entry));
      const loginLocation = await screen.findByRole("status");
      const actualLoginURL = new URL(loginLocation.textContent ?? "", window.location.origin);
      expect(actualLoginURL.pathname).toBe("/login");
      expect(actualLoginURL.searchParams.get("return_to")).toBe(`/app${path}${search}#details`);

      runtime.mode = "authenticated";
      view.rerender(routeTree(entry));
      await waitFor(() => {
        expect(screen.getByRole("status")).toHaveTextContent(`/gateway/models${search}#details`);
      });
      expect(screen.getByRole("status")).toHaveAttribute("data-navigation-type", "REPLACE");
      expect(rendered.mock.calls.every(([value]) => !String(value).includes("private"))).toBe(true);
    },
  );

  it("keeps the existing alias/filter/login round trip as a positive control", async () => {
    runtime.mode = "anonymous";
    const entry = "/models?q=gpt&page=3&token=private#details";
    const view = render(routeTree(entry));
    const loginLocation = await screen.findByRole("status");
    const actualLoginURL = new URL(loginLocation.textContent ?? "", window.location.origin);
    expect(actualLoginURL.searchParams.get("return_to")).toBe("/app/models?q=gpt&page=3#details");
    runtime.mode = "authenticated";
    view.rerender(routeTree(entry));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("/gateway/models?q=gpt&page=3#details");
    });
  });

  it.each(["/gateway/models", "/models"])(
    "%s removes duplicate finite keys before any protected child sees them",
    async (path) => {
      render(routeTree(`${path}?sort=model_asc&sort=model_asc&page_size=25&page_size=50&page=3`));
      expect(await screen.findByRole("status")).toHaveTextContent("/gateway/models?page=3");
      expect(rendered.mock.calls.map(([value]) => value)).toEqual(["/gateway/models?page=3"]);
    },
  );
});
