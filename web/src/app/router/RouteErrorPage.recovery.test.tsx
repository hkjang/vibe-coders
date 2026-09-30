import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RouteErrorPage } from "@/app/router/RouteErrorPage";

const authRuntime = vi.hoisted(() => ({
  current: {
    mode: "authenticated",
    authenticationMode: "session",
    legacyFallback: true,
    user: { scopes: ["admin:read"] } as { scopes: string[] } | undefined,
  },
  listeners: new Set<() => void>(),
}));

// Only authentication state is a component fixture. Route errors, navigation,
// errorElement handling, ErrorState and Legacy permission logic remain real.
// This is not evidence for actual Go authorization or browser chunk transport.
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () =>
    useSyncExternalStore(
      (listener) => {
        authRuntime.listeners.add(listener);
        return () => authRuntime.listeners.delete(listener);
      },
      () => authRuntime.current,
    ),
}));

const routers: ReturnType<typeof createMemoryRouter>[] = [];
const privateDetail = "SYNTHETIC_PRIVATE_ROUTE_CHUNK_DETAIL";

function renderTransition(): {
  user: ReturnType<typeof userEvent.setup>;
  load: ReturnType<typeof vi.fn>;
  router: ReturnType<typeof createMemoryRouter>;
} {
  const load = vi.fn(async () => {
    throw new Error(privateDetail);
  });
  const router = createMemoryRouter([
    {
      errorElement: <RouteErrorPage />,
      children: [
        {
          path: "/",
          element: <Link to="/gateway/providers">공급자 화면 열기</Link>,
        },
        { path: "/gateway/providers", lazy: load },
        {
          path: "/gateway/models",
          lazy: async () => {
            throw new Error("SYNTHETIC_SECOND_ROUTE_CHUNK_DETAIL");
          },
        },
      ],
    },
  ]);
  routers.push(router);
  render(<RouterProvider router={router} />);
  return { user: userEvent.setup(), load, router };
}

async function enterError(): Promise<ReturnType<typeof renderTransition>> {
  const fixture = renderTransition();
  const link = screen.getByRole("link", { name: "공급자 화면 열기" });
  link.focus();
  expect(link).toHaveFocus();
  await fixture.user.click(link);
  expect(await screen.findByRole("heading", { name: "화면 오류" })).toBeVisible();
  expect(fixture.load).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("link", { name: "공급자 화면 열기" })).not.toBeInTheDocument();
  return fixture;
}

describe("RouteErrorPage recovery after an actual router lazy rejection", () => {
  beforeEach(() => {
    authRuntime.current = {
      mode: "authenticated",
      authenticationMode: "session",
      legacyFallback: true,
      user: { scopes: ["admin:read"] },
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    routers.splice(0).forEach((router) => router.dispose());
  });

  it("control: routes the lazy failure to the real error page with safe Korean text and retry", async () => {
    await enterError();

    expect(screen.getByRole("alert")).toHaveTextContent("예기치 못한 화면 오류가 발생했습니다.");
    expect(document.body).not.toHaveTextContent(privateDetail);
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "기존 관리자 화면 열기" })).toHaveAttribute("href", "/admin");
  });

  it.each(["permission missing", "fallback disabled", "user unavailable"])(
    "control: preserves the existing Legacy guard when %s",
    async (condition) => {
      if (condition === "permission missing") authRuntime.current.user = { scopes: ["chat:completion"] };
      if (condition === "fallback disabled") authRuntime.current.legacyFallback = false;
      if (condition === "user unavailable") authRuntime.current.user = undefined;
      await enterError();

      expect(screen.getByRole("button", { name: "다시 시도" })).toBeEnabled();
      expect(screen.queryByRole("link", { name: "기존 관리자 화면 열기" })).not.toBeInTheDocument();
    },
  );

  it("moves focus from the removed route trigger to the error heading before recovery actions", async () => {
    const { user } = await enterError();

    expect(screen.getByRole("heading", { name: "화면 오류" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "다시 시도" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "기존 관리자 화면 열기" })).toHaveFocus();
  });

  it.each(["permission", "fallback"])(
    "control: updates Legacy visibility without stealing retry focus when %s changes",
    async (condition) => {
      await enterError();
      const retry = screen.getByRole("button", { name: "다시 시도" });
      retry.focus();
      expect(retry).toHaveFocus();
      act(() => {
        authRuntime.current = {
          ...authRuntime.current,
          ...(condition === "permission" ? { user: { scopes: [] } } : { legacyFallback: false }),
        };
        authRuntime.listeners.forEach((listener) => listener());
      });
      expect(screen.queryByRole("link", { name: "기존 관리자 화면 열기" })).not.toBeInTheDocument();
      expect(retry).toHaveFocus();

      act(() => {
        authRuntime.current = {
          ...authRuntime.current,
          user: { scopes: ["admin:read"] },
          legacyFallback: true,
        };
        authRuntime.listeners.forEach((listener) => listener());
      });
      expect(screen.getByRole("link", { name: "기존 관리자 화면 열기" })).toHaveAttribute("href", "/admin");
      expect(retry).toHaveFocus();
    },
  );

  it("focuses the heading again for a distinct lazy route error", async () => {
    const { router } = await enterError();
    screen.getByRole("button", { name: "다시 시도" }).focus();
    expect(screen.getByRole("button", { name: "다시 시도" })).toHaveFocus();
    await act(() => router.navigate("/gateway/models"));

    expect(router.state.location.pathname).toBe("/gateway/models");
    expect(screen.getByRole("heading", { name: "화면 오류" })).toHaveFocus();
    expect(document.body).not.toHaveTextContent("SYNTHETIC_SECOND_ROUTE_CHUNK_DETAIL");
  });
});
