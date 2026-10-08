import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { tokenStore } from "@/shared/auth/token-store";

const read = endpoints.domains.observability.llm.evaluations;
const publicBody = { evaluations: [{ request_id: "public-transport-request", reason: "Public result" }] };
const tokens = { access_token: "public-initial-access", refresh_token: "public-initial-refresh" };
const rotated = { access_token: "public-rotated-access", refresh_token: "public-rotated-refresh" };
const refreshed = { access_token: "public-refreshed-access", refresh_token: "public-refreshed-refresh" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// This deliberately non-cooperative synthetic fetch resolves even after its signal
// is aborted. It measures ApiClient's fulfillment/retry boundary, NOT native fetch
// cancellation, Go authorization, or a complete LLM component lifecycle.
function setup() {
  tokenStore.saveTokens(tokens);
  const epoch = tokenStore.getSessionEpoch();
  const calls: Array<{ path: string; method: string; signal: AbortSignal | null | undefined }> = [];
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const saveTokens = vi.fn(tokenStore.refreshTokens);
  const clearTokens = vi.fn(tokenStore.clearTokens);
  const notifyLogout = vi.fn();
  const client = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input), "http://public-test.invalid").pathname;
      calls.push({ path, method: init?.method ?? "GET", signal: init?.signal });
      if (path === endpoints.auth.refresh.path)
        return json({ ...refreshed, token_type: "Bearer", expires_in: 300, refresh_expires_in: 600 });
      if (path !== read.path) throw new Error(`Unexpected synthetic path: ${path}`);
      if (calls.filter((call) => call.path === read.path).length === 1) return held;
      return json(publicBody);
    }),
    getAccessToken: tokenStore.getAccessToken,
    getRefreshToken: tokenStore.getRefreshToken,
    getLegacyToken: tokenStore.getLegacyToken,
    getSessionEpoch: tokenStore.getSessionEpoch,
    saveTokens,
    clearTokens,
    notifyLogout,
  });
  const count = (path: string) => calls.filter((call) => call.path === path).length;
  const start = (signal: AbortSignal) =>
    client.request(read, { signal }).then(
      (value) => ({ outcome: "success" as const, value }),
      (error: unknown) => ({ outcome: "failure" as const, error }),
    );
  return { epoch, calls, count, saveTokens, clearTokens, notifyLogout, release, start };
}

describe("independent LLM read transport abort and late-401 boundary", () => {
  beforeEach(() => tokenStore.clearAll());
  afterEach(() => {
    tokenStore.clearAll();
    vi.restoreAllMocks();
  });

  it("positive: an active read still refreshes once after 401 and retries with the same session epoch", async () => {
    const current = setup();
    const controller = new AbortController();
    const completed = current.start(controller.signal);
    expect(current.count(read.path)).toBe(1);
    current.release(json({ error: { message: "invalid admin token", code: "invalid_api_key" } }, 401));
    const result = await completed;
    expect(result).toMatchObject({
      outcome: "success",
      value: { evaluations: [expect.objectContaining({ reason: "Public result" })] },
    });
    expect(current.count(read.path)).toBe(2);
    expect(current.count(endpoints.auth.refresh.path)).toBe(1);
    expect(current.saveTokens).toHaveBeenCalledOnce();
    expect(tokenStore.getAccessToken()).toBe(refreshed.access_token);
    expect(tokenStore.getSessionEpoch()).toBe(current.epoch);
    expect(current.clearTokens).not.toHaveBeenCalled();
    expect(current.notifyLogout).not.toHaveBeenCalled();
    expect(current.calls.every((call) => !call.signal?.aborted)).toBe(true);
  });

  it.each(["unchanged-access", "already-rotated-access"] as const)(
    "does not refresh or retry a cancelled read when an abort-ignoring transport later resolves 401 (%s)",
    async (branch) => {
      const current = setup();
      const controller = new AbortController();
      const completed = current.start(controller.signal);
      expect(current.count(read.path)).toBe(1);
      if (branch === "already-rotated-access") tokenStore.refreshTokens(rotated);
      const expectedAccess = tokenStore.getAccessToken();
      controller.abort();
      expect(current.calls[0]?.signal?.aborted).toBe(true);
      expect(tokenStore.getSessionEpoch()).toBe(current.epoch);
      current.release(json({ error: { message: "invalid admin token", code: "invalid_api_key" } }, 401));
      const result = await completed;
      expect.soft(result).toMatchObject({ outcome: "failure", error: { kind: "aborted" } });
      expect.soft(current.count(read.path)).toBe(1);
      expect.soft(current.count(endpoints.auth.refresh.path)).toBe(0);
      expect.soft(current.saveTokens).not.toHaveBeenCalled();
      expect.soft(tokenStore.getAccessToken()).toBe(expectedAccess);
      expect(current.clearTokens).not.toHaveBeenCalled();
      expect(current.notifyLogout).not.toHaveBeenCalled();
      expect(tokenStore.getSessionEpoch()).toBe(current.epoch);
    },
  );

  it("does not dispatch an already-aborted read even if the injected transport would ignore that signal", async () => {
    const current = setup();
    const controller = new AbortController();
    controller.abort();
    const completed = current.start(controller.signal);
    current.release(json(publicBody));
    const result = await completed;
    expect.soft(result).toMatchObject({ outcome: "failure", error: { kind: "aborted" } });
    expect.soft(current.count(read.path)).toBe(0);
    expect(current.count(endpoints.auth.refresh.path)).toBe(0);
    expect(current.saveTokens).not.toHaveBeenCalled();
    expect(current.clearTokens).not.toHaveBeenCalled();
    expect(current.notifyLogout).not.toHaveBeenCalled();
    expect(tokenStore.getAccessToken()).toBe(tokens.access_token);
    expect(tokenStore.getSessionEpoch()).toBe(current.epoch);
  });
});
