import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadMultiRunExport } from "./multi-run-export";
import { apiClient } from "@/shared/api/client";
import { downloadApiFile } from "@/shared/api/download-file";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";

vi.mock("@/shared/api/download-file", () => ({ downloadApiFile: vi.fn() }));
beforeEach(() => tokenStore.clearAll());
afterEach(() => {
  tokenStore.clearAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
const formats = [
  { format: "csv", mime: "text/csv", body: "\uFEFFmodel,value\r\n공개 모델,9007199254740993\r\n" },
  { format: "json", mime: "application/json", body: ' {"value":9007199254740993,"name":"공개 합성 자료"}\n' },
  { format: "md", mime: "text/markdown", body: "# 공개 합성 결과\r\n\r\n  원본 공백  \r\n" },
] as const;

describe("typed multi-run file export", () => {
  it.each(formats)(
    "preserves exact $format bytes, path, filename and console metadata",
    async ({ format, mime, body }) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(body, { headers: { "Content-Type": mime + "; charset=utf-8" } }));
      await downloadMultiRunExport("public/run", format, { assertCurrent: () => {} });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[0]).toBe(
        `/admin/chat-test/multi-run/runs/public%2Frun/export?format=${format}`,
      );
      const init = fetch.mock.calls[0]?.[1];
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "same-origin" });
      expect(new Headers(init?.headers).get("Accept")).toBe(mime);
      expect(new Headers(init?.headers).get("X-Vibe-UI")).toBe("app");
      expect(new Headers(init?.headers).get("X-Vibe-Route")).toBe("gateway.chat");
      expect(new Headers(init?.headers).has("X-Vibe-UI-Version")).toBe(true);
      expect(downloadApiFile).toHaveBeenCalledOnce();
      const saved = vi.mocked(downloadApiFile).mock.calls[0];
      if (!saved) throw new Error("missing download");
      expect(saved[0]).toBe(`multi-model-public/run.${format}`);
      expect(Array.from(new Uint8Array(saved[1].bytes))).toEqual(Array.from(new TextEncoder().encode(body)));
    },
  );
  it.each(formats)("rejects an unrelated response MIME for $format", async ({ format }) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("private", {
        headers: { "Content-Type": "text/html", "X-Request-ID": "format-mismatch" },
      }),
    );
    await expect(downloadMultiRunExport("public-run", format)).rejects.toMatchObject({
      kind: "contract",
      requestId: "format-mismatch",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(downloadApiFile).not.toHaveBeenCalled();
  });
  it("does not fetch when the captured read owner denies admission", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      downloadMultiRunExport("public-run", "md", {
        assertCurrent: () => {
          throw new AppError("denied", { kind: "permission" });
        },
      }),
    ).rejects.toMatchObject({ kind: "permission" });
    expect(fetch).not.toHaveBeenCalled();
    expect(downloadApiFile).not.toHaveBeenCalled();
  });
  it.each(["epoch", "owner", "caller"])("discards a late response after %s retirement", async (boundary) => {
    const hold = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(hold.promise);
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "Content-Type": "text/markdown" },
    });
    const caller = new AbortController();
    let current = true;
    const result = downloadMultiRunExport("public-run", "md", {
      signal: caller.signal,
      assertCurrent: () => {
        if (!current) throw new AppError("retired", { kind: "aborted" });
      },
    });
    const rejected = expect(result).rejects.toMatchObject({ kind: "aborted" });
    if (boundary === "epoch") tokenStore.clearAll();
    if (boundary === "owner") current = false;
    if (boundary === "caller") caller.abort();
    hold.resolve(response);
    await rejected;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(downloadApiFile).not.toHaveBeenCalled();
  });
  it.each(["epoch", "owner", "caller"])(
    "cancels an incomplete body after %s retirement",
    async (boundary) => {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          streamController = value;
        },
        cancel,
      });
      const read = vi.spyOn(body, "getReader");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(body, { headers: { "Content-Type": "application/json" } }),
      );
      const caller = new AbortController();
      let current = true;
      const result = downloadMultiRunExport("public-run", "json", {
        signal: caller.signal,
        assertCurrent: () => {
          if (!current) throw new AppError("retired", { kind: "aborted" });
        },
      });
      const rejected = expect(result).rejects.toMatchObject({ kind: "aborted" });
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      if (boundary === "epoch") tokenStore.clearAll();
      if (boundary === "owner") {
        current = false;
        streamController.enqueue(new Uint8Array([32]));
      }
      if (boundary === "caller") caller.abort();
      await rejected;
      expect(cancel).toHaveBeenCalledOnce();
      expect(downloadApiFile).not.toHaveBeenCalled();
    },
  );
  it("applies the full-body deadline and retains the request id without replay", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { "Content-Type": "text/csv", "X-Request-ID": "incomplete-run" },
      }),
    );
    const rejected = expect(downloadMultiRunExport("public-run", "csv")).rejects.toMatchObject({
      kind: "timeout",
      requestId: "incomplete-run",
    });
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(downloadApiFile).not.toHaveBeenCalled();
  });
  it("shares the singleton JSON authentication refresh before one read-only replay", async () => {
    tokenStore.saveTokens({ access_token: "fixture-old", refresh_token: "fixture-refresh" });
    const refresh = deferred<Response>();
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (input === endpoints.auth.refresh.path) return refresh.promise;
      if (new Headers(init?.headers).get("Authorization") !== "Bearer fixture-new") return json({}, 401);
      return input === endpoints.health.path
        ? json({ status: "ok" })
        : new Response("public", { headers: { "Content-Type": "text/markdown" } });
    });
    const file = downloadMultiRunExport("public-run", "md");
    const health = apiClient.request(endpoints.health);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    refresh.resolve(
      json({
        access_token: "fixture-new",
        refresh_token: "fixture-refresh-new",
        expires_in: 900,
        refresh_expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    await file;
    await expect(health).resolves.toEqual({ status: "ok" });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.filter(([input]) => input === endpoints.auth.refresh.path)).toHaveLength(1);
    expect(downloadApiFile).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 500])("preserves HTTP %s and request id without network retries", async (status) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("private", { status, headers: { "X-Request-ID": "run-export-failure" } }),
      );
    await expect(downloadMultiRunExport("public-run", "md")).rejects.toMatchObject({
      status,
      requestId: "run-export-failure",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(downloadApiFile).not.toHaveBeenCalled();
  });
});
