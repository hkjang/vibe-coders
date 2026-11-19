import { AppError } from "@/shared/api/error";
import type { ApiFile, ApiFileEndpoint, ApiFileEndpointData } from "@/shared/api/file-endpoint";
import type { RegisteredFileEndpoint } from "@/shared/api/file-endpoints";
import { readFileBody } from "@/shared/api/read-file-body";
import {
  endpoints,
  type ApiEndpointBase,
  type ApiEndpointData,
  type ApiEndpointOutput,
  type RegisteredApiEndpoint,
} from "@/shared/api/endpoints";
import { openAIErrorSchema } from "@/shared/api/schemas";
import { buildApiPath } from "@/shared/api/query";
import { discardResponse, RequestLifetime } from "@/shared/api/request-lifetime";
import { publishLogout, tokenStore } from "@/shared/auth/token-store";

const defaultTimeoutMs = 15_000;

interface ApiRequestMetadata {
  signal?: AbortSignal;
  timeoutMs?: number;
  routeId?: string;
  retryUnauthorized?: boolean;
}

type ApiEndpointBody<Endpoint extends ApiEndpointBase> =
  ApiEndpointData<Endpoint> extends { body?: infer Body } ? Body : never;

type ApiEndpointQuery<Endpoint extends ApiEndpointBase> =
  ApiEndpointData<Endpoint> extends { query?: infer Query }
    ? Exclude<Query, undefined> extends object
      ? Exclude<Query, undefined>
      : never
    : never;

export type ApiRequestOptions<Endpoint extends ApiEndpointBase> = Omit<
  RequestInit,
  "body" | "method" | "signal"
> &
  ApiRequestMetadata &
  ([ApiEndpointBody<Endpoint>] extends [never]
    ? { readonly body?: never }
    : ApiEndpointData<Endpoint> extends { body: unknown }
      ? { readonly body: ApiEndpointBody<Endpoint> }
      : { readonly body?: ApiEndpointBody<Endpoint> }) &
  ([ApiEndpointQuery<Endpoint>] extends [never]
    ? { readonly query?: never }
    : { readonly query?: ApiEndpointQuery<Endpoint> });

type ApiRequestArguments<Endpoint extends ApiEndpointBase> =
  ApiEndpointData<Endpoint> extends {
    body: unknown;
  }
    ? [options: ApiRequestOptions<Endpoint>]
    : [options?: ApiRequestOptions<Endpoint>];

type ApiFileQuery<Endpoint extends ApiFileEndpoint> =
  ApiFileEndpointData<Endpoint> extends { query?: infer Query } ? Exclude<Query, undefined> : never;

export type ApiFileRequestOptions<Endpoint extends ApiFileEndpoint> = Omit<
  RequestInit,
  "body" | "method" | "signal" | "redirect" | "credentials"
> &
  ApiRequestMetadata & {
    assertCurrent?: () => void;
  } & ([ApiFileQuery<Endpoint>] extends [never] ? { query?: never } : { query?: ApiFileQuery<Endpoint> });

interface InternalApiRequestOptions
  extends Omit<RequestInit, "body" | "method" | "signal">, ApiRequestMetadata {
  body?: unknown;
  query?: object;
}

export interface ApiClientDependencies {
  fetch: typeof globalThis.fetch;
  getAccessToken: () => string;
  getRefreshToken: () => string;
  getLegacyToken: () => string;
  saveTokens: typeof tokenStore.saveTokens;
  clearTokens: () => void;
  notifyLogout: () => void;
  getSessionEpoch: () => number;
  subscribeSession: (listener: () => void) => () => void;
}

function defaultDependencies(): ApiClientDependencies {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    getAccessToken: tokenStore.getAccessToken,
    getRefreshToken: tokenStore.getRefreshToken,
    getLegacyToken: tokenStore.getLegacyToken,
    saveTokens: tokenStore.refreshTokens,
    clearTokens: tokenStore.clearTokens,
    notifyLogout: publishLogout,
    getSessionEpoch: tokenStore.getSessionEpoch,
    subscribeSession: tokenStore.subscribeSession,
  };
}

function isInternalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
}

function requestIdFrom(response: Response, body: unknown): string | undefined {
  const header = response.headers.get("X-Request-ID");
  if (header) return header;
  if (typeof body === "object" && body !== null && "request_id" in body) {
    const value = body.request_id;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.includes("json")) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new AppError("서버가 올바르지 않은 JSON을 반환했습니다.", {
      kind: "contract",
      status: response.status,
      requestId: response.headers.get("X-Request-ID") ?? undefined,
      details: text.slice(0, 500),
      cause,
    });
  }
}

export class ApiClient {
  private readonly dependencies: ApiClientDependencies;
  private refreshFlight: { epoch: number; promise: Promise<void> } | undefined;

  private refreshFailure: { epoch: number; error: AppError } | undefined;

  constructor(dependencies: Partial<ApiClientDependencies> = {}) {
    this.dependencies = {
      ...defaultDependencies(),
      ...dependencies,
      // A custom epoch must not accidentally subscribe to the global token store.
      ...(dependencies.getSessionEpoch && !dependencies.subscribeSession
        ? { subscribeSession: () => () => undefined }
        : {}),
    };
  }

  async request<Endpoint extends RegisteredApiEndpoint>(
    endpoint: Endpoint,
    ...args: ApiRequestArguments<Endpoint>
  ): Promise<ApiEndpointOutput<Endpoint>> {
    const options: InternalApiRequestOptions = args[0] ?? {};
    if (!isInternalPath(endpoint.path)) {
      throw new AppError("외부 API URL은 허용되지 않습니다.", { kind: "contract" });
    }

    const epoch = this.dependencies.getSessionEpoch();
    const lifetime = this.createLifetime(epoch, options.timeoutMs, options.signal);
    try {
      const response = await this.authorizedResponse(endpoint, options, epoch, lifetime);
      const body = await lifetime.run(() => readResponseBody(response));
      if (!response.ok) throw this.endpointError(endpoint, response, body);
      const parsed = endpoint.schema.safeParse(body);
      lifetime.assertActive();
      if (!parsed.success) {
        throw new AppError("API 응답 형식이 예상 계약과 다릅니다.", {
          kind: "contract",
          status: response.status,
          requestId: requestIdFrom(response, body),
          details: parsed.error.flatten(),
        });
      }
      return parsed.data as ApiEndpointOutput<Endpoint>;
    } finally {
      lifetime.dispose();
    }
  }

  async file<Endpoint extends RegisteredFileEndpoint>(
    endpoint: Endpoint,
    options: ApiFileRequestOptions<Endpoint> = {},
  ): Promise<ApiFile> {
    if (!isInternalPath(endpoint.path))
      throw new AppError("외부 API URL은 허용되지 않습니다.", { kind: "contract" });
    const epoch = this.dependencies.getSessionEpoch();
    const { assertCurrent: assertOwner, ...requestOptions } = options;
    const assertCurrent = () => {
      this.assertSession(epoch);
      if (options.signal?.aborted) throw new AppError("이전 내보내기 요청입니다.", { kind: "aborted" });
      assertOwner?.();
    };
    assertCurrent();
    const lifetime = this.createLifetime(epoch, options.timeoutMs, options.signal, assertOwner);
    let response: Response | undefined;
    try {
      const headers = new Headers(options.headers);
      headers.set("Accept", endpoint.contentTypes.join(", "));
      response = await this.authorizedResponse(
        endpoint,
        {
          ...requestOptions,
          headers,
          query: options.query ?? (endpoint.querySchema ? {} : undefined),
          redirect: "error",
          credentials: "same-origin",
          cache: options.cache ?? "no-store",
        },
        epoch,
        lifetime,
      );
      const contentType = response.headers.get("Content-Type") ?? "";
      const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!response.ok) {
        let body: unknown;
        // File errors may echo uploaded/private data. Only structured JSON errors
        // are consumed, within a diagnostic cap; 401 bodies are never needed.
        if (response.status !== 401 && mediaType === "application/json") {
          const bytes = await readFileBody(response, lifetime, {
            maxBytes: Math.min(endpoint.maxBytes ?? 65_536, 65_536),
          });
          try {
            body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
          } catch {
            /* Use safe HTTP fallback. */
          }
        }
        throw this.toAppError(response, body);
      }
      if (!endpoint.contentTypes.includes(mediaType))
        throw new AppError("서버가 요청한 파일 형식으로 응답하지 않았습니다.", {
          kind: "contract",
          status: response.status,
          requestId: lifetime.requestId,
        });
      const bytes = await readFileBody(response, lifetime, endpoint);
      assertCurrent();
      return { bytes, contentType, assertCurrent };
    } finally {
      if (response) discardResponse(response);
      lifetime.dispose();
    }
  }

  private createLifetime(
    epoch: number,
    timeoutMs = defaultTimeoutMs,
    signal?: AbortSignal,
    assertOwner?: () => void,
  ): RequestLifetime {
    return new RequestLifetime(
      () => {
        this.assertSession(epoch);
        assertOwner?.();
      },
      this.dependencies.subscribeSession,
      timeoutMs,
      signal,
    );
  }

  private assertSession(epoch: number): void {
    if (epoch !== this.dependencies.getSessionEpoch()) {
      // A failed current refresh intentionally ends its session. Preserve that auth
      // error for its live waiters; unrelated logout/login remains cancellation.
      if (this.refreshFailure?.epoch === epoch) throw this.refreshFailure.error;
      throw new AppError("인증 세션이 변경되어 이전 요청을 취소했습니다.", { kind: "aborted" });
    }
  }

  private async authorizedResponse(
    endpoint: ApiEndpointBase | ApiFileEndpoint,
    options: InternalApiRequestOptions,
    epoch: number,
    lifetime: RequestLifetime,
  ): Promise<Response> {
    const accessTokenAtStart = this.dependencies.getAccessToken();
    let response = await this.perform(endpoint, options, lifetime);
    if (
      response.status === 401 &&
      options.retryUnauthorized !== false &&
      endpoint.path !== endpoints.auth.refresh.path
    ) {
      const currentAccessToken = this.dependencies.getAccessToken();
      if (currentAccessToken && currentAccessToken !== accessTokenAtStart) {
        discardResponse(response);
        response = await this.perform(endpoint, options, lifetime);
      } else if (this.dependencies.getRefreshToken()) {
        discardResponse(response);
        // This caller can retire promptly without aborting peers' shared refresh.
        await lifetime.run(() => this.refreshOnce(epoch));
        response = await this.perform(endpoint, options, lifetime);
      }
    }
    return response;
  }

  private async refreshOnce(epoch: number): Promise<void> {
    this.assertSession(epoch);
    if (!this.refreshFlight || this.refreshFlight.epoch !== epoch) {
      const promise = this.refresh(epoch).finally(() => {
        if (this.refreshFlight?.promise === promise) this.refreshFlight = undefined;
      });
      this.refreshFlight = { epoch, promise };
    }
    return this.refreshFlight.promise;
  }

  private async refresh(epoch: number): Promise<void> {
    const refreshToken = this.dependencies.getRefreshToken();
    if (!refreshToken) throw new AppError("로그인 세션이 만료되었습니다.", { kind: "auth", status: 401 });
    const lifetime = this.createLifetime(epoch);
    try {
      const refreshBody: ApiEndpointBody<typeof endpoints.auth.refresh> = { refresh_token: refreshToken };
      const response = await this.fetchResponse(
        endpoints.auth.refresh.path,
        {
          method: endpoints.auth.refresh.method,
          headers: this.headers(undefined, false),
          body: JSON.stringify(refreshBody),
        },
        lifetime,
      );
      const body = await lifetime.run(() => readResponseBody(response));
      if (!response.ok) throw this.toAppError(response, body);
      const parsed = endpoints.auth.refresh.schema.safeParse(body);
      lifetime.assertActive();
      if (!parsed.success) {
        throw new AppError("토큰 갱신 응답 형식이 올바르지 않습니다.", {
          kind: "contract",
          status: response.status,
          requestId: requestIdFrom(response, body),
          details: parsed.error.flatten(),
        });
      }
      this.dependencies.saveTokens(parsed.data);
    } catch (cause) {
      this.assertSession(epoch);
      if (cause instanceof AppError && cause.kind === "aborted") throw cause;
      const error = new AppError("로그인 세션이 만료되었습니다. 다시 로그인해 주세요.", {
        kind: "auth",
        status: 401,
        requestId: cause instanceof AppError ? cause.requestId : lifetime.requestId,
        cause,
      });
      this.refreshFailure = { epoch, error };
      this.dependencies.clearTokens();
      this.dependencies.notifyLogout();
      throw error;
    } finally {
      lifetime.dispose();
    }
  }

  private async perform(
    endpoint: ApiEndpointBase | ApiFileEndpoint,
    options: InternalApiRequestOptions,
    lifetime: RequestLifetime,
  ): Promise<Response> {
    const { body, query, timeoutMs, signal, routeId, retryUnauthorized, ...init } = options;
    void retryUnauthorized;
    void timeoutMs;
    void signal;
    lifetime.assertActive();
    const headers = this.headers(init.headers, true, routeId);
    let validatedQuery = query;
    if (query !== undefined) {
      if (!endpoint.querySchema) {
        throw new AppError("이 API는 쿼리 매개변수를 지원하지 않습니다.", {
          kind: "contract",
          details: query,
        });
      }
      const parsedQuery = endpoint.querySchema.safeParse(query);
      if (!parsedQuery.success) {
        throw new AppError("API 쿼리 형식이 예상 계약과 다릅니다.", {
          kind: "contract",
          details: parsedQuery.error.flatten(),
        });
      }
      validatedQuery = parsedQuery.data;
    }
    return this.fetchResponse(
      buildApiPath(endpoint.path, validatedQuery),
      {
        ...init,
        method: endpoint.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      lifetime,
    );
  }

  private headers(source?: HeadersInit, includeAuth = true, routeId?: string): Headers {
    const headers = new Headers(source);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    headers.set("X-Vibe-UI", "app");
    headers.set("X-Vibe-UI-Version", __UI_VERSION__);
    if (routeId) headers.set("X-Vibe-Route", routeId);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (includeAuth) {
      const token = this.dependencies.getAccessToken() || this.dependencies.getLegacyToken();
      if (token) headers.set("Authorization", `Bearer ${token}`);
    }
    return headers;
  }

  private async fetchResponse(path: string, init: RequestInit, lifetime: RequestLifetime): Promise<Response> {
    return lifetime.run(async () => {
      const response = await this.dependencies.fetch(path, { ...init, signal: lifetime.signal });
      lifetime.trackResponse(response);
      return response;
    });
  }

  private toAppError(response: Response, body: unknown): AppError {
    const parsed = openAIErrorSchema.safeParse(body);
    const message = parsed.success
      ? parsed.data.error.message
      : typeof body === "string" && body
        ? body
        : `HTTP ${response.status}`;
    const code = parsed.success ? (parsed.data.error.code ?? undefined) : undefined;
    const kind = response.status === 401 ? "auth" : response.status === 403 ? "permission" : "http";
    return new AppError(message, {
      kind,
      status: response.status,
      code,
      requestId: requestIdFrom(response, body),
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      details: body,
    });
  }

  private endpointError(endpoint: ApiEndpointBase, response: Response, body: unknown): AppError {
    const errorSchema = endpoint.errorSchemas?.[response.status];
    if (!errorSchema) return this.toAppError(response, body);

    const parsed = errorSchema.safeParse(body);
    if (!parsed.success) {
      return new AppError("API 오류 응답 형식이 예상 계약과 다릅니다.", {
        kind: "contract",
        status: response.status,
        requestId: requestIdFrom(response, body),
        details: {
          responseBody: body,
          validation: parsed.error.flatten(),
        },
      });
    }

    const error = this.toAppError(response, parsed.data);
    const message =
      typeof parsed.data === "object" &&
      parsed.data !== null &&
      "error" in parsed.data &&
      typeof parsed.data.error === "string"
        ? parsed.data.error
        : error.message;
    return new AppError(message, {
      kind: error.kind,
      status: error.status,
      code: error.code,
      requestId: requestIdFrom(response, body),
      retryable: error.retryable,
      details: parsed.data,
    });
  }
}

export const apiClient = new ApiClient();
