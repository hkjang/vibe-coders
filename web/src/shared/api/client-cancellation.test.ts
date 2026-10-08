import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { tokenStore } from "@/shared/auth/token-store";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  tokenStore.clearAll();
});

describe("ApiClient caller cancellation boundaries", () => {
  it.each(["success", "failure"])(
    "keeps the shared refresh %s for active callers while retiring only the cancelled caller",
    async (outcome) => {
      tokenStore.saveTokens({ access_token: "synthetic-old", refresh_token: "synthetic-refresh" });
      const pending = deferred<Response>();
      const caller = new AbortController();
      const notifyLogout = vi.fn();
      let refreshes = 0;
      let requests = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === endpoints.auth.refresh.path) {
          refreshes += 1;
          return pending.promise;
        }
        requests += 1;
        return new Headers(init?.headers).get("Authorization") === "Bearer synthetic-fresh"
          ? json({ status: "ok" })
          : json({ error: { message: "expired" } }, 401);
      });
      const client = new ApiClient({ fetch: fetchMock, notifyLogout });
      const retired = client.request(endpoints.health, { signal: caller.signal }).catch((e: unknown) => e);
      const current = client.request(endpoints.health).catch((e: unknown) => e);
      await vi.waitFor(() => {
        expect(refreshes).toBe(1);
        expect(requests).toBe(2);
      });
      caller.abort();
      pending.resolve(
        outcome === "success"
          ? json({
              access_token: "synthetic-fresh",
              refresh_token: "synthetic-next-refresh",
              expires_in: 900,
              refresh_expires_in: 3600,
              token_type: "Bearer",
            })
          : json({ error: { message: "expired" } }, 401),
      );
      await expect(retired).resolves.toMatchObject({ kind: "aborted", retryable: false });
      if (outcome === "success") {
        await expect(current).resolves.toEqual({ status: "ok" });
        expect(requests).toBe(3);
        expect(tokenStore.getAccessToken()).toBe("synthetic-fresh");
        expect(notifyLogout).not.toHaveBeenCalled();
      } else {
        await expect(current).resolves.toMatchObject({ kind: "auth", status: 401 });
        expect(requests).toBe(2);
        expect(tokenStore.getAccessToken()).toBe("");
        expect(notifyLogout).toHaveBeenCalledOnce();
      }
      expect(refreshes).toBe(1);
    },
  );

  it.each(["valid", "invalid"])("does not publish a late %s body after caller cancellation", async (body) => {
    const pending = deferred<string>();
    const response = json({ status: "ok" });
    const read = vi.spyOn(response, "text").mockImplementation(() => pending.promise);
    const fetchMock = vi.fn(async () => response);
    const client = new ApiClient({ fetch: fetchMock });
    const caller = new AbortController();
    const completion = client.request(endpoints.health, { signal: caller.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    caller.abort();
    pending.resolve(body === "valid" ? JSON.stringify({ status: "ok" }) : "not JSON");
    await expect(completion).resolves.toMatchObject({ kind: "aborted", retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a fulfilled timed-out transport before its 401 can start a refresh", async () => {
    vi.useFakeTimers();
    tokenStore.saveTokens({ access_token: "synthetic-old", refresh_token: "synthetic-refresh" });
    const pending = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return pending.promise;
    });
    const client = new ApiClient({ fetch: fetchMock });
    const completion = client.request(endpoints.health, { timeoutMs: 10 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(signal?.aborted).toBe(true);
    // Deliberately simulate a transport that ignores abort, not native fetch behavior.
    pending.resolve(json({ error: { message: "expired" } }, 401));
    await expect(completion).resolves.toMatchObject({ kind: "timeout", retryable: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokenStore.getAccessToken()).toBe("synthetic-old");
  });
});
