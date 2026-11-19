import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { fileEndpoints } from "@/shared/api/file-endpoints";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";

const query = { format: "csv", month: "2026-10" } as const;
const csv = (body = "team,cost\nfixture,1\n") =>
  new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8" } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
afterEach(() => {
  tokenStore.clearAll();
  vi.useRealTimers();
});

describe("typed authenticated file transport", () => {
  it("shares one JSON/CSV refresh, with one authorization retry each", async () => {
    tokenStore.saveTokens({ access_token: "synthetic-old", refresh_token: "synthetic-refresh" });
    const refresh = deferred<Response>();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === endpoints.auth.refresh.path) return refresh.promise;
      if (new Headers(init?.headers).get("Authorization") !== "Bearer synthetic-new")
        return json({ error: { message: "expired" } }, 401);
      return String(input) === endpoints.health.path ? json({ status: "ok" }) : csv();
    });
    const client = new ApiClient({ fetch });
    const jsonResult = client.request(endpoints.health);
    const csvResult = client.file(fileEndpoints.chargeback, { query });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    refresh.resolve(
      json({
        access_token: "synthetic-new",
        refresh_token: "synthetic-next",
        expires_in: 900,
        refresh_expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    await expect(jsonResult).resolves.toEqual({ status: "ok" });
    const file = await csvResult;
    expect(new TextDecoder().decode(file.bytes)).toBe("team,cost\nfixture,1\n");
    expect(fetch.mock.calls.filter(([input]) => input === endpoints.auth.refresh.path)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("cancels a CSV waiter promptly while JSON still uses the shared refresh", async () => {
    vi.useFakeTimers();
    tokenStore.saveTokens({ access_token: "synthetic-old", refresh_token: "synthetic-refresh" });
    const refresh = deferred<Response>();
    let refreshSignal: AbortSignal | null | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === endpoints.auth.refresh.path) {
        refreshSignal = init?.signal;
        return refresh.promise;
      }
      return new Headers(init?.headers).get("Authorization") === "Bearer synthetic-new"
        ? json({ status: "ok" })
        : json({ error: { message: "expired" } }, 401);
    });
    const client = new ApiClient({ fetch });
    const controller = new AbortController();
    const retired = client
      .file(fileEndpoints.chargeback, { query, signal: controller.signal })
      .catch((error: unknown) => error);
    const active = client.request(endpoints.health);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await expect(retired).resolves.toMatchObject({ kind: "aborted" });
    expect(refreshSignal?.aborted).toBe(false);
    refresh.resolve(
      json({
        access_token: "synthetic-new",
        refresh_token: "synthetic-next",
        expires_in: 900,
        refresh_expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    await expect(active).resolves.toEqual({ status: "ok" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each(["logout", "owner", "caller"])("rechecks a ready file before use after %s", async (boundary) => {
    let allowed = true;
    const caller = new AbortController();
    const client = new ApiClient({ fetch: vi.fn(async () => csv()) });
    const file = await client.file(fileEndpoints.chargeback, {
      query,
      signal: caller.signal,
      assertCurrent: () => {
        if (!allowed) throw new AppError("permission changed", { kind: "permission" });
      },
    });
    if (boundary === "logout") tokenStore.clearAll();
    if (boundary === "owner") allowed = false;
    if (boundary === "caller") caller.abort();
    expect(file.assertCurrent).toThrowError(
      expect.objectContaining({ kind: boundary === "owner" ? "permission" : "aborted" }),
    );
  });

  it("cancels an owned body's reader when permission changes while it is pending", async () => {
    let allowed = true;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel,
    });
    const reader = vi.spyOn(body, "getReader");
    const client = new ApiClient({
      fetch: vi.fn(async () => new Response(body, { headers: { "Content-Type": "text/csv" } })),
    });
    const pending = client.file(fileEndpoints.chargeback, {
      query,
      assertCurrent: () => {
        if (!allowed) throw new AppError("revoked", { kind: "permission" });
      },
    });
    const denied = expect(pending).rejects.toMatchObject({ kind: "permission" });
    await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce());
    allowed = false;
    controller.enqueue(new TextEncoder().encode("must not download"));
    await denied;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects oversized error bodies with request id and cancels instead of truncating", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_537));
      },
      cancel,
    });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(body, {
          status: 500,
          headers: { "Content-Type": "application/json", "X-Request-ID": "file-error-limit" },
        }),
    );
    const client = new ApiClient({ fetch });
    await expect(client.file(fileEndpoints.chargeback, { query })).rejects.toMatchObject({
      kind: "contract",
      code: "response_too_large",
      requestId: "file-error-limit",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not expose a raw HTML error body or follow a redirect", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("PRIVATE_RAW_BODY"));
      },
      cancel,
    });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(body, {
          status: 500,
          headers: { "Content-Type": "text/html", "X-Request-ID": "safe-error" },
        }),
    );
    const client = new ApiClient({ fetch });
    await expect(client.file(fileEndpoints.chargeback, { query })).rejects.toMatchObject({
      kind: "http",
      message: "HTTP 500",
      requestId: "safe-error",
    });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", credentials: "same-origin" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("validates registered queries and internal paths before any fetch", async () => {
    const fetch = vi.fn();
    const client = new ApiClient({ fetch });
    await expect(
      client.file(fileEndpoints.chargeback, { query: { ...query, month: "2026-13" } }),
    ).rejects.toMatchObject({ kind: "contract" });
    await expect(client.file(fileEndpoints.chargeback)).rejects.toMatchObject({ kind: "contract" });
    const external = {
      ...fileEndpoints.chargeback,
      path: "https://invalid.example/file",
    } as unknown as typeof fileEndpoints.chargeback;
    await expect(client.file(external, { query })).rejects.toMatchObject({ kind: "contract" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function compileTimeContracts(client: ApiClient): void {
  // @ts-expect-error JSON operations cannot be consumed as unvalidated file bytes.
  void client.file(endpoints.health);
  // @ts-expect-error File operations cannot bypass their MIME/byte contract via JSON request().
  void client.request(fileEndpoints.policyBackup);
  // @ts-expect-error CSV format is fixed by the registered operation.
  void client.file(fileEndpoints.chargeback, { query: { month: "2026-10", format: "json" } });
  // @ts-expect-error File reads cannot carry a write body.
  void client.file(fileEndpoints.policyBackup, { body: "unregistered write" });
  // @ts-expect-error The file transport forbids redirect opt-outs.
  void client.file(fileEndpoints.policyBackup, { redirect: "follow" });
}
void compileTimeContracts;
