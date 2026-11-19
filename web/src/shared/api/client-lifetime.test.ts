import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { tokenStore } from "@/shared/auth/token-store";

function json(body: unknown, status = 200, requestId = "lifetime-fixture"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const rotatedTokens = {
  access_token: "synthetic-fresh",
  refresh_token: "synthetic-next",
  expires_in: 900,
  refresh_expires_in: 3600,
  token_type: "Bearer",
};

afterEach(() => {
  vi.useRealTimers();
  tokenStore.clearAll();
});

describe("ApiClient whole-response lifetime", () => {
  it("preserves refresh auth failures with an isolated epoch dependency", async () => {
    let epoch = 10;
    const clearTokens = vi.fn(() => {
      epoch += 1;
    });
    const client = new ApiClient({
      fetch: vi.fn(async () => json({ error: { message: "expired" } }, 401)),
      getSessionEpoch: () => epoch,
      getAccessToken: () => "synthetic-expired",
      getRefreshToken: () => "synthetic-refresh",
      clearTokens,
      notifyLogout: vi.fn(),
    });
    await expect(client.request(endpoints.health)).rejects.toMatchObject({ kind: "auth", status: 401 });
    expect(clearTokens).toHaveBeenCalledOnce();
  });

  it.each(["success", "http", "timeout", "session"])(
    "releases injected session listeners after %s",
    async (outcome) => {
      vi.useFakeTimers();
      let epoch = 1;
      const listeners = new Set<() => void>();
      const pending = deferred<Response>();
      const client = new ApiClient({
        fetch: vi.fn(async () =>
          outcome === "timeout" || outcome === "session"
            ? pending.promise
            : outcome === "http"
              ? json({ error: { message: "unavailable" } }, 503)
              : json({ status: "ok" }),
        ),
        getSessionEpoch: () => epoch,
        subscribeSession: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      });
      let result: unknown;
      const completion = client.request(endpoints.health, { timeoutMs: 10 }).then(
        (value) => {
          result = value;
        },
        (error: unknown) => {
          result = error;
        },
      );
      try {
        expect(listeners.size).toBe(1);
        if (outcome === "session") {
          epoch += 1;
          listeners.forEach((listener) => listener());
        }
        await vi.advanceTimersByTimeAsync(10);
        expect(listeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(result).toMatchObject(
          outcome === "success" ? { status: "ok" } : { kind: outcome === "session" ? "aborted" : outcome },
        );
      } finally {
        pending.resolve(json({ status: "ok" }));
        await completion;
      }
    },
  );

  it.each([200, 500])("times out a stalled %s body after headers, with its request id", async (status) => {
    vi.useFakeTimers();
    const body = deferred<string>();
    const response = json({ status: "ok" }, status, "stalled-body");
    vi.spyOn(response, "text").mockImplementation(() => body.promise);
    let signal: AbortSignal | null | undefined;
    const client = new ApiClient({
      fetch: vi.fn(async (_input, init) => {
        signal = init?.signal;
        return response;
      }),
    });
    let result: unknown;
    const completion = client.request(endpoints.health, { timeoutMs: 20 }).catch((error: unknown) => {
      result = error;
    });
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(result).toMatchObject({ kind: "timeout", requestId: "stalled-body", retryable: true });
      expect(signal?.aborted).toBe(true);
    } finally {
      body.resolve(JSON.stringify({ status: "ok" }));
      await completion;
    }
  });

  it("settles a cancelled caller before its shared refresh finishes, leaving an active peer intact", async () => {
    vi.useFakeTimers();
    tokenStore.saveTokens({ access_token: "synthetic-old", refresh_token: "synthetic-refresh" });
    const refresh = deferred<Response>();
    let refreshSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === endpoints.auth.refresh.path) {
        refreshSignal = init?.signal;
        return refresh.promise;
      }
      return new Headers(init?.headers).get("Authorization") === "Bearer synthetic-fresh"
        ? json({ status: "ok" })
        : json({ error: { message: "expired" } }, 401);
    });
    const client = new ApiClient({ fetch: fetchMock });
    const caller = new AbortController();
    let retired: unknown;
    const first = client.request(endpoints.health, { signal: caller.signal }).catch((error: unknown) => {
      retired = error;
    });
    const second = client.request(endpoints.health);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshSignal).toBeDefined();
      caller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(retired).toMatchObject({ kind: "aborted", retryable: false });
      expect(refreshSignal?.aborted).toBe(false);
    } finally {
      refresh.resolve(json(rotatedTokens));
      await first;
      await expect(second).resolves.toEqual({ status: "ok" });
    }
    expect(fetchMock.mock.calls.filter(([input]) => input === endpoints.auth.refresh.path)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("settles logout immediately even when transport ignores the abort signal", async () => {
    vi.useFakeTimers();
    const transport = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    const client = new ApiClient({
      fetch: vi.fn((_input, init) => {
        signal = init?.signal;
        return transport.promise;
      }),
    });
    let result: unknown;
    const completion = client.request(endpoints.health).catch((error: unknown) => {
      result = error;
    });
    try {
      tokenStore.clearAll();
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toMatchObject({ kind: "aborted", retryable: false });
      expect(signal?.aborted).toBe(true);
    } finally {
      transport.resolve(json({ status: "ok" }));
      await completion;
    }
  });

  it("bounds a stalled refresh body, signs out once, and does not retry or save late tokens", async () => {
    vi.useFakeTimers();
    tokenStore.saveTokens({ access_token: "synthetic-old", refresh_token: "synthetic-refresh" });
    const body = deferred<string>();
    const refreshResponse = json(rotatedTokens, 200, "stalled-refresh");
    vi.spyOn(refreshResponse, "text").mockImplementation(() => body.promise);
    const notifyLogout = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === endpoints.auth.refresh.path
        ? refreshResponse
        : json({ error: { message: "expired" } }, 401),
    );
    const client = new ApiClient({ fetch: fetchMock, notifyLogout });
    let result: unknown;
    const completion = client.request(endpoints.health, { timeoutMs: 30_000 }).catch((error: unknown) => {
      result = error;
    });
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(result).toMatchObject({
        kind: "auth",
        status: 401,
        requestId: "stalled-refresh",
        cause: expect.objectContaining({ kind: "timeout", requestId: "stalled-refresh" }),
      });
      expect(tokenStore.getAccessToken()).toBe("");
      expect(notifyLogout).toHaveBeenCalledOnce();
    } finally {
      body.resolve(JSON.stringify(rotatedTokens));
      await completion;
    }
    expect(tokenStore.getAccessToken()).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses one caller deadline across the first attempt, shared refresh and retry body", async () => {
    vi.useFakeTimers();
    tokenStore.saveTokens({ access_token: "synthetic-old", refresh_token: "synthetic-refresh" });
    const refresh = deferred<Response>();
    const body = deferred<string>();
    const finalResponse = json({ status: "ok" }, 200, "retry-body");
    vi.spyOn(finalResponse, "text").mockImplementation(() => body.promise);
    const client = new ApiClient({
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === endpoints.auth.refresh.path) return refresh.promise;
        return new Headers(init?.headers).get("Authorization") === "Bearer synthetic-fresh"
          ? finalResponse
          : json({ error: { message: "expired" } }, 401);
      }),
    });
    let result: unknown;
    const completion = client.request(endpoints.health, { timeoutMs: 100 }).catch((error: unknown) => {
      result = error;
    });
    try {
      await vi.advanceTimersByTimeAsync(80);
      refresh.resolve(json(rotatedTokens));
      await vi.advanceTimersByTimeAsync(20);
      expect(result).toMatchObject({ kind: "timeout", requestId: "retry-body" });
    } finally {
      body.resolve(JSON.stringify({ status: "ok" }));
      await completion;
    }
  });

  it("normalizes a body connection failure while preserving the response request id", async () => {
    const response = json({ status: "ok" }, 200, "body-network");
    vi.spyOn(response, "text").mockRejectedValue(new TypeError("connection reset"));
    const fetchMock = vi.fn(async () => response);
    const client = new ApiClient({ fetch: fetchMock });
    await expect(client.request(endpoints.health)).rejects.toMatchObject({
      kind: "network",
      requestId: "body-network",
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
