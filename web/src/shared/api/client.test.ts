import { describe, expect, it, vi } from "vitest";

import { ApiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

describe("ApiClient", () => {
  it("shares one refresh request across concurrent 401 responses and retries each request once", async () => {
    let accessToken = "expired-access";
    let refreshCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === endpoints.auth.refresh.path) {
        refreshCount += 1;
        await Promise.resolve();
        return jsonResponse({
          access_token: "fresh-access",
          expires_in: 900,
          refresh_expires_in: 3600,
          refresh_token: "fresh-refresh",
          token_type: "Bearer",
        });
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      return authorization === "Bearer fresh-access"
        ? jsonResponse({ status: "ok" })
        : jsonResponse({ error: { message: "expired" } }, 401);
    });
    const client = new ApiClient({
      fetch: fetchMock as typeof fetch,
      getAccessToken: () => accessToken,
      getRefreshToken: () => "refresh-token",
      getLegacyToken: () => "",
      saveTokens: (tokens) => {
        accessToken = tokens.access_token;
      },
      clearTokens: vi.fn(),
      notifyLogout: vi.fn(),
    });

    const [first, second] = await Promise.all([
      client.request(endpoints.health),
      client.request(endpoints.health),
    ]);

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(refreshCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("does not refresh again when a staggered 401 arrives after the access token changed", async () => {
    let accessToken = "expired-access";
    let refreshCount = 0;
    let expiredRequestCount = 0;
    let releaseLateUnauthorized: (() => void) | undefined;
    const lateUnauthorized = new Promise<void>((resolve) => {
      releaseLateUnauthorized = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === endpoints.auth.refresh.path) {
        refreshCount += 1;
        return jsonResponse({
          access_token: "fresh-access",
          expires_in: 900,
          refresh_expires_in: 3600,
          refresh_token: "fresh-refresh",
          token_type: "Bearer",
        });
      }

      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization === "Bearer fresh-access") {
        releaseLateUnauthorized?.();
        return jsonResponse({ status: "ok" });
      }

      expiredRequestCount += 1;
      if (expiredRequestCount === 2) await lateUnauthorized;
      return jsonResponse({ error: { message: "expired" } }, 401);
    });
    const client = new ApiClient({
      fetch: fetchMock as typeof fetch,
      getAccessToken: () => accessToken,
      getRefreshToken: () => "refresh-token",
      getLegacyToken: () => "",
      saveTokens: (tokens) => {
        accessToken = tokens.access_token;
      },
      clearTokens: vi.fn(),
      notifyLogout: vi.fn(),
    });

    const [first, second] = await Promise.all([
      client.request(endpoints.health),
      client.request(endpoints.health),
    ]);

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(refreshCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("adds UI identity, route and request auth headers", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Vibe-UI")).toBe("app");
      expect(headers.get("X-Vibe-UI-Version")).toBe("test");
      expect(headers.get("X-Vibe-Route")).toBe("overview");
      expect(headers.get("Authorization")).toBe("Bearer access");
      return jsonResponse({ status: "ok" });
    });
    const client = new ApiClient({
      fetch: fetchMock as typeof fetch,
      getAccessToken: () => "access",
      getRefreshToken: () => "",
      getLegacyToken: () => "",
    });

    await expect(client.request(endpoints.health, { routeId: "overview" })).resolves.toEqual({
      status: "ok",
    });
  });

  it("uses the generated operation method and serializes its typed body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        email: "admin@example.test",
        password: "secret",
      });
      return jsonResponse({
        access_token: "access",
        expires_in: 900,
        refresh_expires_in: 3_600,
        refresh_token: "refresh",
        token_type: "Bearer",
      });
    });
    const client = new ApiClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.request(endpoints.auth.login, {
        body: { email: "admin@example.test", password: "secret" },
        retryUnauthorized: false,
      }),
    ).resolves.toMatchObject({ access_token: "access" });
  });

  it("rejects external URLs before calling fetch", async () => {
    const fetchMock = vi.fn();
    const client = new ApiClient({ fetch: fetchMock as typeof fetch });
    const externalEndpoint = {
      ...endpoints.health,
      path: "https://attacker.example/data",
    } as unknown as typeof endpoints.health;
    await expect(client.request(externalEndpoint)).rejects.toMatchObject({ kind: "contract" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the request id on API errors", async () => {
    const client = new ApiClient({
      fetch: vi.fn(async () =>
        jsonResponse({ error: { message: "failed" } }, 503, { "X-Request-ID": "req-42" }),
      ) as typeof fetch,
    });
    await expect(client.request(endpoints.health, { retryUnauthorized: false })).rejects.toMatchObject({
      kind: "http",
      requestId: "req-42",
      retryable: true,
    });
  });

  it("validates and preserves the typed readiness payload on 503 responses", async () => {
    const client = new ApiClient({
      fetch: vi.fn(async () =>
        jsonResponse({ status: "not_ready", error: "database unavailable" }, 503, {
          "X-Request-ID": "req-ready-503",
        }),
      ) as typeof fetch,
    });

    await expect(client.request(endpoints.ready, { retryUnauthorized: false })).rejects.toMatchObject({
      kind: "http",
      status: 503,
      message: "database unavailable",
      requestId: "req-ready-503",
      retryable: true,
      details: { status: "not_ready", error: "database unavailable" },
    });
  });

  it("preserves a body request id before normalizing a typed readiness error", async () => {
    const client = new ApiClient({
      fetch: vi.fn(async () =>
        jsonResponse(
          {
            status: "not_ready",
            error: "database unavailable",
            request_id: "req-ready-body",
          },
          503,
        ),
      ) as typeof fetch,
    });

    await expect(client.request(endpoints.ready, { retryUnauthorized: false })).rejects.toMatchObject({
      requestId: "req-ready-body",
      details: { status: "not_ready", error: "database unavailable" },
    });
  });

  it("reports malformed typed error payloads as contract failures with diagnostics", async () => {
    const responseBody = { status: "not_ready" };
    const client = new ApiClient({
      fetch: vi.fn(async () =>
        jsonResponse(responseBody, 503, { "X-Request-ID": "req-ready-contract" }),
      ) as typeof fetch,
    });

    await expect(client.request(endpoints.ready, { retryUnauthorized: false })).rejects.toMatchObject({
      kind: "contract",
      status: 503,
      requestId: "req-ready-contract",
      retryable: false,
      details: {
        responseBody,
        validation: {
          fieldErrors: { error: [expect.any(String)] },
        },
      },
    });
  });

  it("serializes and validates endpoint-specific query parameters", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      expect(String(input)).toBe("/admin/routing/health?window=1h&threshold=0");
      return jsonResponse({
        since: "2026-09-02T00:00:00Z",
        until: "2026-09-02T01:00:00Z",
        threshold: 0,
        providers: [],
        ranking: [],
        degraded: [],
        alerts: [],
        trend: [],
        breakers: {
          enabled: true,
          threshold: 5,
          cooldown_seconds: 30,
          states: [],
          shared: false,
          instance_id: "gateway-1",
        },
      });
    });
    const client = new ApiClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.request(endpoints.admin.routing.health, {
        query: { window: "1h", threshold: 0 },
      }),
    ).resolves.toMatchObject({ threshold: 0 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects invalid endpoint query values before calling fetch", async () => {
    const fetchMock = vi.fn();
    const client = new ApiClient({ fetch: fetchMock as typeof fetch });
    const invalidQuery = { threshold: 101 } as unknown as {
      threshold: 0;
    };

    await expect(
      client.request(endpoints.admin.routing.health, { query: invalidQuery }),
    ).rejects.toMatchObject({ kind: "contract" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects query parameters on operations that do not declare them", async () => {
    const fetchMock = vi.fn();
    const client = new ApiClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.request(endpoints.health, { query: { window: "1h" } } as never),
    ).rejects.toMatchObject({ kind: "contract" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports response schema mismatches as contract errors with request ids", async () => {
    const client = new ApiClient({
      fetch: vi.fn(async () =>
        jsonResponse({ total_requests: "not-a-number" }, 200, { "X-Request-ID": "req-contract" }),
      ) as typeof fetch,
    });

    await expect(client.request(endpoints.admin.stats)).rejects.toMatchObject({
      kind: "contract",
      requestId: "req-contract",
      status: 200,
    });
  });
});

function compileTimeOperationContracts(client: ApiClient): void {
  void client.request(endpoints.auth.login, {
    body: { email: "admin@example.test", password: "secret" },
  });

  // @ts-expect-error The OpenAPI operation fixes POST and does not allow a method override.
  void client.request(endpoints.auth.login, { method: "DELETE", body: { email: "a", password: "b" } });

  // @ts-expect-error PostAuthLoginData requires a body.
  void client.request(endpoints.auth.login);

  // @ts-expect-error AuthLoginRequest requires both email and password.
  void client.request(endpoints.auth.login, { body: { email: "admin@example.test" } });

  // @ts-expect-error GetHealthData does not accept a request body.
  void client.request(endpoints.health, { body: { unrelated: true } });

  void client.request(endpoints.admin.routing.health, {
    query: { window: "24h", threshold: 70 },
  });

  // @ts-expect-error Routing health only accepts its declared query keys.
  void client.request(endpoints.admin.routing.health, { query: { provider: "openai" } });

  // @ts-expect-error Routing health threshold must be numeric.
  void client.request(endpoints.admin.routing.health, { query: { threshold: "70" } });

  // @ts-expect-error Health has no query contract.
  void client.request(endpoints.health, { query: { window: "1h" } });

  const forgedDelete = { ...endpoints.auth.login, method: "DELETE" as const };
  // @ts-expect-error ApiClient only accepts the registered POST operation descriptor.
  void client.request(forgedDelete, { body: { email: "a", password: "b" } });
}

void compileTimeOperationContracts;
