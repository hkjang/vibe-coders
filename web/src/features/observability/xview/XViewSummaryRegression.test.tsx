import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { XViewPage } from "@/features/observability/xview/XViewPage";
import { ApiClient, apiClient } from "@/shared/api/client";
import { FeatureAccessHarness } from "@/test/feature-access";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("uses the server's nearest-rank P95 for exactly twenty displayed request points", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T09:00:00Z"));
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input), "http://public-test.invalid");
    let response: unknown;
    if (url.pathname === "/admin/saved-filters") response = { filters: [] };
    else if (url.pathname === "/admin/scatter") {
      response = {
        points: Array.from({ length: 20 }, (_, index) => ({
          request_id: `public-p95-${index + 1}`,
          created_at: "2026-10-08T08:59:30Z",
          ingested_at: "2026-10-08T08:59:31.000000000Z",
          latency_ms: index + 1,
          status_code: 200,
          model: "public-model",
          provider: "public-provider",
          endpoint: "/v1/chat/completions",
        })),
        groups: [],
        truncated: false,
        since: "2026-10-08T08:55:00Z",
        cursor: { ingested_at: "2026-10-08T08:59:31.000000000Z", request_id: "public-p95-20" },
        server_time: "2026-10-08T09:00:00Z",
      };
    } else throw new Error(`Unexpected synthetic transport path: ${url.pathname}`);
    return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
  });
  const transport = new ApiClient({
    fetch,
    getAccessToken: () => "",
    getRefreshToken: () => "",
    getLegacyToken: () => "",
    getSessionEpoch: () => 0,
    clearTokens: vi.fn(),
    saveTokens: vi.fn(),
    notifyLogout: vi.fn(),
  });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  renderScreen(
    <FeatureAccessHarness featureId="observability.xview">
      <XViewPage />
    </FeatureAccessHarness>,
    { path: "/observability/xview", route: "/observability/xview?window=5m&live=off" },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  const summary = screen.getByRole("region", { name: "지금 확인할 신호" });
  expect(within(summary).getByText("20")).toBeVisible();
  const percentile = within(summary).getByText("지연 P95").closest("article");
  expect(percentile).not.toBeNull();
  // Go percentileInt (admin_xview.go) and the legacy XView both use
  // ceil(n * .95) - 1: for [1..20], the nineteenth point is 19ms, not 20ms.
  expect(percentile).toHaveTextContent("19ms");
});
