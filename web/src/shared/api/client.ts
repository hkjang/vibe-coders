import { AppError } from "@/shared/api/error";
import {
  endpoints,
  type ApiEndpointBase,
  type ApiEndpointData,
  type ApiEndpointOutput,
  type RegisteredApiEndpoint,
} from "@/shared/api/endpoints";
import { openAIErrorSchema } from "@/shared/api/schemas";
import { buildApiPath } from "@/shared/api/query";
import { publishLogout, tokenStore } from "@/shared/auth/token-store";

const defaultTimeoutMs = 15_000;

interface ApiRequestMetadata {
  signal?: AbortSignal;
  timeoutMs?: number;
  routeId?: string;
  retryUnauthorized?: boolean;
}

type ApiEndpointBody<Endpoint extends ApiEndpointBase> =
  ApiEndpointData<Endpoint> extends { body: infer Body } ? Body : never;

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
    : { readonly body: ApiEndpointBody<Endpoint> }) &
  ([ApiEndpointQuery<Endpoint>] extends [never]
    ? { readonly query?: never }
    : { readonly query?: ApiEndpointQuery<Endpoint> });

type ApiRequestArguments<Endpoint extends ApiEndpointBase> = [ApiEndpointBody<Endpoint>] extends [never]
  ? [options?: ApiRequestOptions<Endpoint>]
  : [options: ApiRequestOptions<Endpoint>];

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
}

function defaultDependencies(): ApiClientDependencies {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    getAccessToken: tokenStore.getAccessToken,
    getRefreshToken: tokenStore.getRefreshToken,
    getLegacyToken: tokenStore.getLegacyToken,
    saveTokens: tokenStore.refreshTokens,
    clearTokens: tokenStore.clearTokens,
    notifyLogout: publishLogout,
    getSessionEpoch: tokenStore.getSessionEpoch,
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

  constructor(dependencies: Partial<ApiClientDependencies> = {}) {
    this.dependencies = { ...defaultDependencies(), ...dependencies };
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
    const accessTokenAtRequestStart = this.dependencies.getAccessToken();
    let response = await this.inSession(epoch, () => this.perform(endpoint, options), options.signal);
    this.assertSession(epoch, options.signal);
    if (
      response.status === 401 &&
      options.retryUnauthorized !== false &&
      endpoint.path !== endpoints.auth.refresh.path
    ) {
      const currentAccessToken = this.dependencies.getAccessToken();
      if (currentAccessToken && currentAccessToken !== accessTokenAtRequestStart) {
        response = await this.inSession(
          epoch,
          () => this.perform(endpoint, { ...options, retryUnauthorized: false }),
          options.signal,
        );
      } else if (this.dependencies.getRefreshToken()) {
        // A caller cannot cancel the shared refresh needed by other active requests.
        // Once it settles, only this caller's retry is suppressed if it was cancelled.
        try {
          await this.refreshOnce(epoch);
        } catch (error) {
          this.assertNotAborted(options.signal);
          throw error;
        }
        this.assertSession(epoch, options.signal);
        response = await this.inSession(
          epoch,
          () => this.perform(endpoint, { ...options, retryUnauthorized: false }),
          options.signal,
        );
      }
    }

    const body = await this.inSession(epoch, () => readResponseBody(response), options.signal);
    this.assertSession(epoch, options.signal);
    if (!response.ok) throw this.endpointError(endpoint, response, body);

    const parsed = endpoint.schema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("API 응답 형식이 예상 계약과 다릅니다.", {
        kind: "contract",
        status: response.status,
        requestId: requestIdFrom(response, body),
        details: parsed.error.flatten(),
      });
    }
    return parsed.data as ApiEndpointOutput<Endpoint>;
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AppError("API 요청이 취소되었습니다.", { kind: "aborted" });
  }

  private assertSession(epoch: number, signal?: AbortSignal): void {
    if (epoch !== this.dependencies.getSessionEpoch()) {
      throw new AppError("인증 세션이 변경되어 이전 요청을 취소했습니다.", { kind: "aborted" });
    }
    this.assertNotAborted(signal);
  }

  private async inSession<Value>(
    epoch: number,
    read: () => Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> {
    this.assertSession(epoch, signal);
    try {
      const value = await read();
      this.assertSession(epoch, signal);
      return value;
    } catch (error) {
      // A transport or body reader may settle after its session or caller has retired.
      this.assertSession(epoch, signal);
      throw error;
    }
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

    try {
      const refreshBody: ApiEndpointBody<typeof endpoints.auth.refresh> = { refresh_token: refreshToken };
      const response = await this.fetchWithTimeout(
        endpoints.auth.refresh.path,
        {
          method: endpoints.auth.refresh.method,
          headers: this.headers(undefined, false),
          body: JSON.stringify(refreshBody),
        },
        defaultTimeoutMs,
        undefined,
      );
      const body = await readResponseBody(response);
      this.assertSession(epoch);
      if (!response.ok) throw this.toAppError(response, body);
      const parsed = endpoints.auth.refresh.schema.safeParse(body);
      if (!parsed.success) {
        throw new AppError("토큰 갱신 응답 형식이 올바르지 않습니다.", {
          kind: "contract",
          status: response.status,
          requestId: requestIdFrom(response, body),
          details: parsed.error.flatten(),
        });
      }
      this.dependencies.saveTokens(parsed.data);
    } catch (error) {
      this.assertSession(epoch);
      if (error instanceof AppError && error.kind === "aborted") throw error;
      this.dependencies.clearTokens();
      this.dependencies.notifyLogout();
      throw new AppError("로그인 세션이 만료되었습니다. 다시 로그인해 주세요.", {
        kind: "auth",
        status: 401,
        cause: error,
      });
    }
  }

  private async perform(endpoint: ApiEndpointBase, options: InternalApiRequestOptions): Promise<Response> {
    const {
      body,
      query,
      timeoutMs = defaultTimeoutMs,
      signal,
      routeId,
      retryUnauthorized,
      ...init
    } = options;
    void retryUnauthorized;
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
    return this.fetchWithTimeout(
      buildApiPath(endpoint.path, validatedQuery),
      {
        ...init,
        method: endpoint.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      timeoutMs,
      signal,
    );
  }

  private headers(source?: HeadersInit, includeAuth = true, routeId?: string): Headers {
    const headers = new Headers(source);
    headers.set("Accept", "application/json");
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

  private async fetchWithTimeout(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    this.assertNotAborted(externalSignal);
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromCaller();
    else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.dependencies.fetch(path, { ...init, signal: controller.signal });
      // Fulfilled transports must honor cancellation too, before any auth retry.
      if (controller.signal.aborted) throw new AppError("종료된 API 응답입니다.", { kind: "aborted" });
      return response;
    } catch (cause) {
      if (timedOut) {
        throw new AppError("API 요청 시간이 초과되었습니다.", {
          kind: "timeout",
          retryable: true,
          cause,
        });
      }
      if (externalSignal?.aborted || controller.signal.aborted) {
        throw new AppError("API 요청이 취소되었습니다.", { kind: "aborted", cause });
      }
      throw new AppError("게이트웨이에 연결할 수 없습니다.", {
        kind: "network",
        retryable: true,
        cause,
      });
    } finally {
      window.clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    }
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
