import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";

const endpoint = endpoints.domains.redteam.probePacks.import;
const csv = '\ufeffcase_key,input_template\r\npublic,"한글, exact bytes"\r\n';
const result = { imported_cases: 1, packs_touched: 1, skipped: [] };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-ID": "public-csv-request" },
  });
beforeEach(() => tokenStore.clearAll());
afterEach(() => {
  tokenStore.clearAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("registered raw text writes", () => {
  it("preserves exact CSV text and forces same-origin, no-redirect, non-replayed JSON transport", async () => {
    tokenStore.saveTokens({ access_token: "synthetic-access", refresh_token: "synthetic-refresh" });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ ...result, skipped: null }));
    const client = new ApiClient({ fetch });
    await expect(
      client.request(endpoint, {
        body: csv,
        routeId: "security.redteam",
        redirect: "follow",
        credentials: "include",
        cache: "force-cache",
        retryUnauthorized: true,
        headers: { "Content-Type": "application/json", Accept: "text/html" },
      }),
    ).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("/admin/redteam/probe-packs/import");
    expect(init).toMatchObject({
      method: "POST",
      body: csv,
      redirect: "error",
      credentials: "same-origin",
      cache: "no-store",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("text/csv");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Authorization")).toBe("Bearer synthetic-access");
    expect(headers.get("X-Vibe-UI")).toBe("app");
    expect(headers.get("X-Vibe-UI-Version")).toBe(__UI_VERSION__);
    expect(headers.get("X-Vibe-Route")).toBe("security.redteam");
  });

  it("does not refresh or replay 401 even if the token changes while the write is in flight", async () => {
    tokenStore.saveTokens({ access_token: "synthetic-old", refresh_token: "synthetic-refresh" });
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      tokenStore.refreshTokens({ access_token: "synthetic-new", refresh_token: "synthetic-refresh" });
      return new Response(new ReadableStream({ cancel }), {
        status: 401,
        headers: { "Content-Type": "application/json", "X-Request-ID": "csv-no-replay" },
      });
    });
    await expect(
      new ApiClient({ fetch }).request(endpoint, { body: csv, retryUnauthorized: true }),
    ).rejects.toMatchObject({
      kind: "auth",
      status: 401,
      requestId: "csv-no-replay",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(tokenStore.getAccessToken()).toBe("synthetic-new");
  });

  it.each([403, 503])("never replays HTTP %s and retains its request ID", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ error: { message: "public failure" } }, status),
    );
    await expect(new ApiClient({ fetch }).request(endpoint, { body: csv })).rejects.toMatchObject({
      kind: status === 403 ? "permission" : "http",
      status,
      requestId: "public-csv-request",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never replays an uncertain network failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("connection closed");
    });
    await expect(new ApiClient({ fetch }).request(endpoint, { body: csv })).rejects.toMatchObject({
      kind: "network",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("accepts exactly 8 MiB and rejects one extra UTF-8 byte before dispatch", async () => {
    const limit = 8 * 1024 * 1024;
    const exact = "한".repeat(Math.floor(limit / 3)) + "x".repeat(limit % 3);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(result));
    const client = new ApiClient({ fetch });
    await expect(client.request(endpoint, { body: exact })).resolves.toEqual(result);
    expect(new TextEncoder().encode(fetch.mock.calls[0]?.[1]?.body as string)).toHaveLength(limit);
    await expect(client.request(endpoint, { body: exact + "x" })).rejects.toMatchObject({
      code: "request_too_large",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a JSON object at compile time and at runtime before dispatch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(result));
    // @ts-expect-error A registered CSV write requires text, not a JSON object.
    await expect(new ApiClient({ fetch }).request(endpoint, { body: { csv } })).rejects.toMatchObject({
      kind: "contract",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { imported_cases: "1", packs_touched: 1, skipped: [] },
    { imported_cases: -1, packs_touched: 1, skipped: [] },
  ])("rejects malformed import response contracts", async (value) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(value));
    await expect(new ApiClient({ fetch }).request(endpoint, { body: csv })).rejects.toMatchObject({
      kind: "contract",
      requestId: "public-csv-request",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([200, 500])("cancels unread non-JSON status %s without exposing the raw body", async (status) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("PRIVATE_INPUT_ECHO"));
      },
      cancel,
    });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(stream, {
          status,
          headers: { "Content-Type": "text/html", "X-Request-ID": "non-json-csv" },
        }),
    );
    const error: unknown = await new ApiClient({ fetch })
      .request(endpoint, { body: csv })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ kind: status === 200 ? "contract" : "http", requestId: "non-json-csv" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_INPUT_ECHO");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds chunked error diagnostics and cancels their reader", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_537));
      },
      cancel,
    });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(stream, {
          status: 500,
          headers: { "Content-Type": "application/json", "X-Request-ID": "csv-error-cap" },
        }),
    );
    await expect(new ApiClient({ fetch }).request(endpoint, { body: csv })).rejects.toMatchObject({
      code: "response_too_large",
      requestId: "csv-error-cap",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "caller", "logout"])(
    "retires a pending response body on %s without replay",
    async (boundary) => {
      vi.useFakeTimers();
      let finish!: (value: string) => void;
      const held = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const response = json(result);
      const read = vi.spyOn(response, "text").mockReturnValue(held);
      const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
      const controller = new AbortController();
      const pending = new ApiClient({ fetch }).request(endpoint, {
        body: csv,
        signal: controller.signal,
        timeoutMs: 50,
      });
      const rejected = expect(pending).rejects.toMatchObject({
        kind: boundary === "timeout" ? "timeout" : "aborted",
        requestId: "public-csv-request",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledOnce();
      if (boundary === "timeout") await vi.advanceTimersByTimeAsync(50);
      else if (boundary === "caller") controller.abort();
      else tokenStore.clearAll();
      await rejected;
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      finish(JSON.stringify(result));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("rejects retired owner admission and checks the owner again before returning a result", async () => {
    let current = false;
    const assertCurrent = () => {
      if (!current) throw new AppError("retired", { kind: "aborted" });
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      current = false;
      return json(result);
    });
    const client = new ApiClient({ fetch });
    await expect(client.request(endpoint, { body: csv, assertCurrent })).rejects.toMatchObject({
      kind: "aborted",
    });
    expect(fetch).not.toHaveBeenCalled();
    current = true;
    await expect(client.request(endpoint, { body: csv, assertCurrent })).rejects.toMatchObject({
      kind: "aborted",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
