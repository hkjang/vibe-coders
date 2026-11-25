import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { createMemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthContextValue } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { tokenStore } from "@/shared/auth/token-store";
import { testAuth } from "@/test/auth";
import { ConsoleActions } from "./ConsoleActions";
import { captureAction } from "./action-channel";
import { captureAPIError, installDiagnosticSink } from "./diagnostic-channel";
const auth = vi.hoisted(() => ({ current: {} as AuthContextValue }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => auth.current }));
let router: ReturnType<typeof createMemoryRouter>;
beforeEach(() => {
  auth.current = testAuth({ backendVersion: "v0.86.181", telemetryEnabled: true });
  router = createMemoryRouter([{ path: "*", element: null }], {
    initialEntries: ["/app/overview?private-search=secret"],
  });
});
afterEach(() => {
  router.dispose();
  tokenStore.clearAll();
});
it("sends a nonce and fixed categories only, with no retries, referrer, response, identity or payload", () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(undefined as never);
  render(
    <StrictMode>
      <ConsoleActions router={router}>콘솔</ConsoleActions>
    </StrictMode>,
  );
  const first = captureAction("save", { password: "private" });
  act(() => {
    first?.success();
    first?.success();
    captureAction("approve", "private")?.success();
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0]?.[0]).toBe(endpoints.uiActions.events);
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    body: {
      feature_id: "overview",
      action: "save",
      outcome: "success",
      event_id: expect.stringMatching(/^[0-9a-f]{32}$/),
    },
    referrerPolicy: "no-referrer",
    retryUnauthorized: false,
    timeoutMs: 2000,
    keepalive: true,
  });
  const firstID = (request.mock.calls[0]?.[1]?.body as { event_id: string }).event_id;
  const secondID = (request.mock.calls[1]?.[1]?.body as { event_id: string }).event_id;
  expect(firstID).not.toBe(secondID);
  expect(JSON.stringify(request.mock.calls.map((call) => call[1]))).not.toMatch(
    /private|secret|password|email|prompt|search|\/app/,
  );
});
it.each(["off", "older", "signed-out", "hidden", "app-disabled"])(
  "does not capture while %s",
  (condition) => {
    if (condition === "off") auth.current.telemetryEnabled = false;
    if (condition === "older") auth.current.backendVersion = "v0.86.180";
    if (condition === "signed-out") auth.current.mode = "anonymous";
    if (condition === "app-disabled") auth.current.uiEnabled = false;
    if (condition === "hidden")
      auth.current.features = auth.current.features.map((feature) =>
        feature.featureId === "overview" ? { ...feature, status: "hidden" } : feature,
      );
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(undefined as never);
    render(<ConsoleActions router={router}>콘솔</ConsoleActions>);
    act(() => captureAction("delete", undefined)?.success());
    expect(request).not.toHaveBeenCalled();
  },
);
it("discards an outstanding completion after opt-out and blocks logout before React rerenders", () => {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(undefined as never);
  const view = render(<ConsoleActions router={router}>콘솔</ConsoleActions>);
  const captured = captureAction("save", undefined);
  auth.current = { ...auth.current, telemetryEnabled: false };
  view.rerender(<ConsoleActions router={router}>콘솔</ConsoleActions>);
  act(() => captured?.success());
  auth.current = { ...auth.current, telemetryEnabled: true };
  view.rerender(<ConsoleActions router={router}>콘솔</ConsoleActions>);
  const signedOut = captureAction("delete", undefined);
  tokenStore.clearAll();
  act(() => {
    signedOut?.success();
    captureAction("save", undefined)?.success();
  });
  expect(request).not.toHaveBeenCalled();
});
it("does not turn its own reporting failure into API-error observations", () => {
  const send = vi.fn(),
    retire = installDiagnosticSink(() => "overview", send);
  try {
    expect(captureAPIError(endpoints.uiActions.events)).toBeUndefined();
    expect(captureAPIError(endpoints.uiActions.summary)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  } finally {
    retire();
  }
});
