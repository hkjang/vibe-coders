import { screen, within, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { SessionPage } from "./SessionPage";
import { flightRecorderResponseSchema } from "@/shared/api/domains/observability.schemas";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";
const runtime = vi.hoisted(() => ({ version: "v0.86.163", supported: true }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ backendVersion: runtime.version });
      return { ...auth, capabilities: { ...auth.capabilities, legacy_session_detail: runtime.supported } };
    },
  };
});
const target = "reader@example.invalid";
const href = "/admin#/sessions?" + new URLSearchParams({ session_id: target });
function setup(query = "?session_id=" + encodeURIComponent(target)) {
  return renderScreen(
    <FeatureAccessHarness featureId="observability.sessions">
      <SessionPage />
    </FeatureAccessHarness>,
    { path: "/observability/sessions", route: "/observability/sessions" + query },
  );
}
function fixtures(fail = false) {
  return mockApi({
    "GET /admin/sessions": () => {
      if (fail) throw apiFailure("unavailable");
      return { days: 7, sessions: [], note: "" };
    },
    "GET /admin/sessions/page": () => {
      if (fail) throw apiFailure("unavailable");
      return {
        session_page_version: 1,
        days: 7,
        limit: 25,
        offset: 0,
        from: "2026-11-10T00:00:00Z",
        to: "2026-11-17T00:00:00Z",
        sessions: [],
        summary: { sessions: 0, requests: 0, errors: 0, total_tokens: 0, cost_krw: 0 },
      };
    },
    ["GET /admin/sessions/" + encodeURIComponent(target) + "/flight-recorder"]: () =>
      flightRecorderResponseSchema.parse({ session_id: "[REDACTED_EMAIL]", events: [] }),
  });
}
beforeEach(() => {
  runtime.version = "v0.86.163";
  runtime.supported = true;
});
it.each(["v0.86.152", "v0.86.163"])(
  "keeps the actual target across projected display and catalog failure on %s",
  async (version) => {
    runtime.version = version;
    const api = fixtures(true);
    setup();
    const sheet = await screen.findByRole("dialog", { name: "세션 비행기록" });
    expect(await within(sheet).findByText("[REDACTED_EMAIL]")).toBeVisible();
    expect(within(sheet).getByRole("link", { name: "기존 화면에서 같은 세션 열기" })).toHaveAttribute(
      "href",
      href,
    );
    expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
    expect(api.calls.some((call) => call.key.includes("REDACTED"))).toBe(false);
  },
);
it.each(["v0.86.152", "v0.86.163"])(
  "does not select the first duplicate or trimmed alias on %s",
  async (version) => {
    runtime.version = version;
    const api = fixtures();
    setup("?session_id=%20" + encodeURIComponent(target) + "%20&session_id=" + encodeURIComponent(target));
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(0));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.calls.some((call) => call.key.includes("/flight-recorder"))).toBe(false);
  },
);
it("falls back to the registered route when the server lacks the capability", async () => {
  runtime.supported = false;
  fixtures();
  setup();
  const sheet = await screen.findByRole("dialog", { name: "세션 비행기록" });
  expect(within(sheet).getByRole("link", { name: "기존 화면에서 열기" })).toHaveAttribute(
    "href",
    "/admin#/sessions",
  );
});
