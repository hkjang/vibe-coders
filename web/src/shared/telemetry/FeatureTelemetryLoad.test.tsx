import { act, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { createMemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContextValue } from "@/app/auth/AuthProvider";
import { AppRouterProvider } from "@/app/router/AppRouterProvider";
import { featureByPath } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { FeatureTelemetry } from "@/shared/telemetry/FeatureTelemetry";
import { observeRouteLoads } from "@/shared/telemetry/route-load";
import { testAuth } from "@/test/auth";

const auth = vi.hoisted(() => ({ current: {} as AuthContextValue }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => auth.current }));
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let clock = 0;
let router: ReturnType<typeof createMemoryRouter> | undefined;

function Screen() {
  const { pathname } = useLocation();
  return (
    <FeatureTelemetry feature={featureByPath(pathname)}>
      <p>화면 준비</p>
    </FeatureTelemetry>
  );
}
function paint() {
  act(() => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(clock);
    }
  });
}
beforeEach(() => {
  auth.current = testAuth({ telemetryEnabled: true, backendVersion: "v0.86.179" });
  clock = 100;
  frames.clear();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([
    { name: "", entryType: "navigation", startTime: 0, duration: 0, toJSON: () => ({}) },
  ]);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
});
afterEach(() => {
  router?.dispose();
  router = undefined;
});

describe("feature first display observation", () => {
  it("records after a paint opportunity once in StrictMode, without counting filter changes", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(undefined as never);
    router = createMemoryRouter([{ path: "/system/settings", Component: Screen }], {
      initialEntries: ["/system/settings"],
    });
    observeRouteLoads(router);
    render(
      <StrictMode>
        <AppRouterProvider router={router} />
      </StrictMode>,
    );
    expect(screen.getByText("화면 준비")).toBeVisible();
    expect(request.mock.calls.map(([, options]) => options?.body)).toHaveLength(1);
    paint();
    expect(request).toHaveBeenCalledTimes(1);
    clock = 250;
    paint();
    expect(request.mock.calls[1]?.[1]?.body).toEqual({
      ...(request.mock.calls[0]?.[1]?.body as object),
      event: "page_load",
      load_ms: 250,
    });
    await act(async () => {
      await router?.navigate("/system/settings?tab=private");
    });
    paint();
    paint();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["older-backend", "opt-out", "hidden"])("does not send a load sample for %s", (condition) => {
    if (condition === "older-backend") auth.current.backendVersion = "v0.86.178";
    if (condition === "opt-out") auth.current.telemetryEnabled = false;
    if (condition === "hidden") vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(undefined as never);
    router = createMemoryRouter([{ path: "/system/settings", Component: Screen }], {
      initialEntries: ["/system/settings"],
    });
    observeRouteLoads(router);
    render(<AppRouterProvider router={router} />);
    paint();
    paint();
    expect(
      request.mock.calls.some(([, options]) => (options?.body as { event?: string })?.event === "page_load"),
    ).toBe(false);
    expect(request).toHaveBeenCalledTimes(condition === "opt-out" ? 0 : 1);
  });
});
