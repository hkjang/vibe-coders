import { act, render, screen } from "@testing-library/react";
import { StrictMode, useSyncExternalStore } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthContextValue } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { tokenStore } from "@/shared/auth/token-store";
import { AppError } from "@/shared/api/error";
import { RouteErrorPage } from "@/app/router/RouteErrorPage";
import { testAuth } from "@/test/auth";
import { ConsoleDiagnostics } from "./ConsoleDiagnostics";
import { captureAPIError, reportBoundaryError } from "./diagnostic-channel";

const auth = vi.hoisted(() => ({ current: {} as AuthContextValue, listeners: new Set<() => void>() }));
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () =>
    useSyncExternalStore(
      (listener) => {
        auth.listeners.add(listener);
        return () => auth.listeners.delete(listener);
      },
      () => auth.current,
    ),
}));
let router: ReturnType<typeof createMemoryRouter>;
beforeEach(() => {
  auth.current = testAuth({ backendVersion: "v0.86.180", telemetryEnabled: true });
  router = createMemoryRouter([{ path: "*", element: null }], {
    initialEntries: ["/app/overview?private-search=secret"],
  });
});
afterEach(() => router.dispose());

it("sends only a fresh nonce and fixed classification with no referrer, replay or login refresh", () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(undefined as never);
  render(
    <StrictMode>
      <ConsoleDiagnostics router={router}>
        <p>콘솔</p>
      </ConsoleDiagnostics>
    </StrictMode>,
  );
  const error = new TypeError("private prompt");
  act(() => {
    reportBoundaryError(error, "route");
    reportBoundaryError(error, "route");
  });
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    body: {
      kind: "js_error",
      feature_id: "overview",
      event_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      failure: "type",
      boundary: "route",
    },
    referrerPolicy: "no-referrer",
    retryUnauthorized: false,
    timeoutMs: 2000,
  });
  expect(JSON.stringify(request.mock.calls[0]?.[1])).not.toMatch(/private|secret|prompt|search|\/app/);
});

it.each(["off", "older", "signed-out", "hidden"])("does not collect while %s", (condition) => {
  if (condition === "off") auth.current.telemetryEnabled = false;
  if (condition === "older") auth.current.backendVersion = "v0.86.179";
  if (condition === "signed-out") auth.current.mode = "anonymous";
  if (condition === "hidden")
    auth.current.features = auth.current.features.map((feature) =>
      feature.featureId === "overview" ? { ...feature, status: "hidden" } : feature,
    );
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(undefined as never);
  render(
    <ConsoleDiagnostics router={router}>
      <p>콘솔</p>
    </ConsoleDiagnostics>,
  );
  act(() => reportBoundaryError(new Error("private"), "root"));
  expect(request).not.toHaveBeenCalled();
});

it("retires outstanding captures on opt-out and blocks the interval before a changed account rerenders", () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(undefined as never);
  const view = render(
    <ConsoleDiagnostics router={router}>
      <p>콘솔</p>
    </ConsoleDiagnostics>,
  );
  const captured = captureAPIError(endpoints.health);
  auth.current = { ...auth.current, telemetryEnabled: false };
  view.rerender(
    <ConsoleDiagnostics router={router}>
      <p>콘솔</p>
    </ConsoleDiagnostics>,
  );
  act(() => captured?.(new AppError("private", { kind: "http", status: 503 })));
  expect(request).not.toHaveBeenCalled();
  auth.current = { ...auth.current, telemetryEnabled: true };
  view.rerender(
    <ConsoleDiagnostics router={router}>
      <p>콘솔</p>
    </ConsoleDiagnostics>,
  );
  tokenStore.clearAll();
  act(() => reportBoundaryError(new Error("private"), "root"));
  expect(request).not.toHaveBeenCalled();
});

it("observes a still-visible cold route failure only after opt-in resolves, without stealing focus or replaying on auth updates", async () => {
  auth.current = { ...auth.current, mode: "loading", telemetryEnabled: false };
  router.dispose();
  router = createMemoryRouter(
    [
      {
        path: "/app/overview",
        lazy: async () => {
          throw new TypeError("private cold-load detail");
        },
        errorElement: <RouteErrorPage />,
      },
    ],
    { initialEntries: ["/app/overview"] },
  );
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(undefined as never);
  const tree = () => (
    <ConsoleDiagnostics router={router}>
      <RouterProvider router={router} />
    </ConsoleDiagnostics>
  );
  const view = render(tree());
  await screen.findByRole("heading", { name: "화면 오류" });
  expect(request).not.toHaveBeenCalled();
  const retry = screen.getByRole("button", { name: "다시 시도" });
  retry.focus();
  auth.current = testAuth({ backendVersion: "v0.86.180", telemetryEnabled: true });
  act(() => auth.listeners.forEach((listener) => listener()));
  view.rerender(tree());
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    body: { kind: "js_error", failure: "type", boundary: "route", feature_id: "overview" },
  });
  expect(retry).toHaveFocus();
  auth.current = { ...auth.current, expiresAt: 123 };
  act(() => auth.listeners.forEach((listener) => listener()));
  view.rerender(tree());
  expect(request).toHaveBeenCalledOnce();
  expect(retry).toHaveFocus();
});

it("captures an immediate root render failure after its parent establishes the opted-in session", () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(undefined as never);
  function Broken(): never {
    throw new TypeError("private root-render payload");
  }
  render(
    <StrictMode>
      <ConsoleDiagnostics router={router}>
        <Broken />
      </ConsoleDiagnostics>
    </StrictMode>,
  );
  expect(screen.getByRole("heading", { name: "신규 콘솔에서 오류가 발생했습니다." })).toHaveFocus();
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    body: { kind: "js_error", boundary: "root", failure: "type" },
  });
  expect(JSON.stringify(request.mock.calls)).not.toContain("private");
});
