import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { fileEndpoints } from "@/shared/api/file-endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { captureAPIError, installDiagnosticSink, reportBoundaryError } from "./diagnostic-channel";

let dispose: (() => void) | undefined;
afterEach(() => dispose?.());
const response = (status = 503, id = "trace_" + "a".repeat(32)) =>
  new Response(JSON.stringify({ error: { message: "private-prompt", code: "private-secret" } }), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-ID": id },
  });

describe("bounded diagnostic channel", () => {
  it("keeps only the registered template, HTTP status and gateway-shaped correlation from a real client failure", async () => {
    const send = vi.fn();
    dispose = installDiagnosticSink(() => "observability.requests", send);
    const client = new ApiClient({ fetch: vi.fn(async () => response()), getRefreshToken: () => "" });
    const endpoint = withPathParams(endpoints.domains.observability.requests.io, { id: "private/customer" });
    await expect(client.request(endpoint, { query: { reveal: "raw" } })).rejects.toMatchObject({
      status: 503,
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      feature_id: "observability.requests",
      kind: "api_error",
      endpoint: "/admin/requests/{id}/io",
      method: "GET",
      status: 503,
      request_id: "trace_" + "a".repeat(32),
      failure: "http",
    });
    expect(JSON.stringify(send.mock.calls)).not.toMatch(/private|reveal|raw/);
  });

  it("uses the original template for file failures and drops arbitrary request IDs", async () => {
    const send = vi.fn();
    dispose = installDiagnosticSink(() => "gateway.chat", send);
    const client = new ApiClient({
      fetch: vi.fn(async () => response(403, "private-user:key")),
      getRefreshToken: () => "",
    });
    await expect(
      client.file(withPathParams(fileEndpoints.multiRunCsv, { id: "private-run" }), {
        query: { format: "csv" },
      }),
    ).rejects.toMatchObject({ kind: "permission" });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      feature_id: "gateway.chat",
      kind: "api_error",
      endpoint: "/admin/chat-test/multi-run/runs/{id}/export",
      method: "GET",
      status: 403,
      failure: "permission",
    });
  });

  it.each(["auth", "telemetry", "diagnostics"])("never observes %s transport or recurses", (kind) => {
    const send = vi.fn();
    dispose = installDiagnosticSink(() => "overview", send);
    const endpoint =
      kind === "auth"
        ? endpoints.auth.me
        : kind === "telemetry"
          ? endpoints.uiTelemetry.summary
          : endpoints.uiDiagnostics.summary;
    expect(captureAPIError(endpoint)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("drops canceled, unconfigured and retired-owner completions", async () => {
    expect(captureAPIError(endpoints.health)).toBeUndefined();
    const old = vi.fn();
    const next = vi.fn();
    dispose = installDiagnosticSink(() => "overview", old);
    const capture = captureAPIError(endpoints.health);
    capture?.(new AppError("private", { kind: "aborted" }));
    expect(old).not.toHaveBeenCalled();
    dispose();
    dispose = installDiagnosticSink(() => "me.home", next);
    capture?.(new AppError("private", { kind: "http", status: 503 }));
    expect(old).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    let reject!: (error: Error) => void;
    const client = new ApiClient({
      fetch: () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    });
    const pending = client.request(endpoints.health).catch((error: unknown) => error);
    tokenStore.clearAll();
    reject(new Error("private-network"));
    await expect(pending).resolves.toMatchObject({ kind: "aborted" });
    expect(next).not.toHaveBeenCalled();
  });

  it("reports only the terminal request failure after a successful shared refresh", async () => {
    const send = vi.fn();
    dispose = installDiagnosticSink(() => "overview", send);
    tokenStore.saveTokens({ access_token: "old", refresh_token: "refresh" });
    let calls = 0;
    const client = new ApiClient({
      fetch: vi.fn(async (input) => {
        if (String(input) === "/auth/refresh")
          return new Response(
            JSON.stringify({
              access_token: "new",
              refresh_token: "renewed",
              token_type: "Bearer",
              expires_in: 300,
              refresh_expires_in: 3600,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        calls += 1;
        return calls === 1
          ? response(401)
          : new Response('{"status":"ok"}', { headers: { "Content-Type": "application/json" } });
      }),
    });
    await expect(client.request(endpoints.health)).resolves.toEqual({ status: "ok" });
    expect(send).not.toHaveBeenCalled();
  });

  it("classifies native errors without their custom names, stack, cause or message and deduplicates a boundary error", () => {
    const send = vi.fn();
    dispose = installDiagnosticSink(() => "overview", send);
    const error = new TypeError("private-prompt", { cause: "private-response" });
    error.name = "private-email";
    error.stack = "private-stack";
    reportBoundaryError(error, "route");
    reportBoundaryError(error, "root");
    expect(send).toHaveBeenCalledExactlyOnceWith({
      feature_id: "overview",
      kind: "js_error",
      boundary: "route",
      failure: "type",
    });
  });

  it("caps events at 20 per minute without queues and isolates sink exceptions", () => {
    const send = vi.fn();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    dispose = installDiagnosticSink(() => "overview", send);
    for (let i = 0; i < 25; i += 1) reportBoundaryError(new Error(), "root");
    expect(send).toHaveBeenCalledTimes(20);
    now = 60_000;
    reportBoundaryError(new Error(), "root");
    expect(send).toHaveBeenCalledTimes(21);
    dispose();
    dispose = installDiagnosticSink(
      () => "overview",
      () => {
        throw new Error("observer offline");
      },
    );
    expect(() => reportBoundaryError(new Error(), "root")).not.toThrow();
  });
});
