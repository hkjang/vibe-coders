import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient, apiClient } from "@/shared/api/client";
import { createFeatureVisit } from "@/shared/telemetry/visit";
import type { MockedRequestOptions } from "@/test/api";

function mockTransport(fetch: typeof globalThis.fetch) {
  const saveTokens = vi.fn();
  const clearTokens = vi.fn();
  const notifyLogout = vi.fn();
  const client = new ApiClient({
    fetch,
    getAccessToken: () => "existing-access",
    getRefreshToken: () => "existing-refresh",
    getLegacyToken: () => "",
    saveTokens,
    clearTokens,
    notifyLogout,
  });
  const request = vi.spyOn(apiClient, "request").mockImplementation(client.request.bind(client));
  const settled = () =>
    Promise.allSettled(
      request.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
    );
  return { request, settled, saveTokens, clearTokens, notifyLogout };
}

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("feature visit transport", () => {
  it("sends each event once with one fresh 32-hex visit ID and accepts empty 204 responses", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = mockTransport(fetch);
    const visit = createFeatureVisit("system.settings");
    visit.recordVisit();
    visit.recordVisit();
    visit.recordLegacyOpen();
    visit.recordLegacyOpen();
    const results = await transport.settled();

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = transport.request.mock.calls[0]?.[1] as MockedRequestOptions | undefined;
    expect(first).toEqual({
      body: {
        feature_id: "system.settings",
        visit_id: expect.stringMatching(/^[a-f0-9]{32}$/),
        event: "visit",
      },
      routeId: "ui.telemetry",
      keepalive: true,
      referrerPolicy: "no-referrer",
      retryUnauthorized: false,
      timeoutMs: 2_000,
    });
    expect(transport.request.mock.calls[1]?.[1]?.body).toEqual({
      ...(first?.body as object),
      event: "legacy_fallback",
    });
    for (const [endpoint] of transport.request.mock.calls) {
      expect(endpoint).toMatchObject({ method: "POST", path: "/admin/ui-telemetry/events" });
    }
  });

  it("does not place location, identity or page content in the body or referrer, or persist a visit", async () => {
    window.history.replaceState(
      null,
      "",
      "/app/system/settings?user=private-user&team=private-team&prompt=private-prompt#private-fragment",
    );
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    const transport = mockTransport(fetch);
    const visit = createFeatureVisit("system.settings");
    visit.recordVisit();
    visit.recordLegacyOpen();
    await transport.settled();

    expect(storageWrite).not.toHaveBeenCalled();
    for (const [input, init] of fetch.mock.calls) {
      expect(input).toBe("/admin/ui-telemetry/events");
      const body: unknown = JSON.parse(String(init?.body));
      expect(body).toEqual({
        feature_id: "system.settings",
        visit_id: expect.stringMatching(/^[a-f0-9]{32}$/),
        event: expect.stringMatching(/^(visit|legacy_fallback)$/),
      });
      expect(init?.referrerPolicy).toBe("no-referrer");
      expect(init?.referrer).toBeUndefined();
      expect(new Headers(init?.headers).has("Referer")).toBe(false);
      expect(String(init?.body)).not.toMatch(/private-|\/app\/|https?:|prompt|team|user/);
    }
  });

  it.each([401, 503, "network"] as const)(
    "silently drops %s failures without retry, token refresh, logout or persistent storage",
    async (failure) => {
      vi.useFakeTimers();
      const storageWrite = vi.spyOn(Storage.prototype, "setItem");
      const consoleError = vi.spyOn(console, "error");
      const fetch = vi.fn(async () => {
        if (failure === "network") throw new TypeError("private network detail");
        return new Response(JSON.stringify({ error: { message: "private server detail" } }), {
          status: failure,
          headers: { "Content-Type": "application/json" },
        });
      });
      const transport = mockTransport(fetch);
      const visit = createFeatureVisit("system.settings");
      expect(() => visit.recordVisit()).not.toThrow();
      expect(() => visit.recordLegacyOpen()).not.toThrow();
      await transport.settled();
      await vi.advanceTimersByTimeAsync(10_000);
      visit.recordVisit();
      visit.recordLegacyOpen();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(
        transport.request.mock.calls.every(([endpoint]) => endpoint.path === "/admin/ui-telemetry/events"),
      ).toBe(true);
      expect(transport.saveTokens).not.toHaveBeenCalled();
      expect(transport.clearTokens).not.toHaveBeenCalled();
      expect(transport.notifyLogout).not.toHaveBeenCalled();
      expect(storageWrite).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it("fails closed when secure randomness is unavailable", () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("secure randomness unavailable");
    });
    const request = vi.spyOn(apiClient, "request");
    expect(() => {
      const visit = createFeatureVisit("system.settings");
      visit.recordVisit();
      visit.recordLegacyOpen();
    }).not.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
