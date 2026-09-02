import { AppError } from "@/shared/api/error";
import {
  endpoints,
  type ApiEndpointBase,
  type ApiEndpointData,
  type ApiEndpointOutput,
  type RegisteredApiEndpoint,
} from "@/shared/api/endpoints";
import { openAIErrorSchema } from "@/shared/api/schemas";
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

export type ApiRequestOptions<Endpoint extends ApiEndpointBase> = Omit<
  RequestInit,
  "body" | "method" | "signal"
> &
  ApiRequestMetadata &
  ([ApiEndpointBody<Endpoint>] extends [never]
    ? { readonly body?: never }
    : { readonly body: ApiEndpointBody<Endpoint> });

type ApiRequestArguments<Endpoint extends ApiEndpointBase> = [ApiEndpointBody<Endpoint>] extends [never]
  ? [options?: ApiRequestOptions<Endpoint>]
  : [options: ApiRequestOptions<Endpoint>];

interface InternalApiRequestOptions
  extends Omit<RequestInit, "body" | "method" | "signal">, ApiRequestMetadata {
  body?: unknown;
}

export interface ApiClientDependencies {
  fetch: typeof globalThis.fetch;
  getAccessToken: () => string;
  getRefreshToken: () => string;
  getLegacyToken: () => string;
  saveTokens: typeof tokenStore.saveTokens;
  clearTokens: () => void;
  notifyLogout: () => void;
}

function defaultDependencies(): ApiClientDependencies {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    getAccessToken: tokenStore.getAccessToken,
    getRefreshToken: tokenStore.getRefreshToken,
    getLegacyToken: tokenStore.getLegacyToken,
    saveTokens: tokenStore.saveTokens,
    clearTokens: tokenStore.clearTokens,
    notifyLogout: publishLogout,
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
  private refreshFlight: Promise<void> | undefined;

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

    const accessTokenAtRequestStart = this.dependencies.getAccessToken();
    let response = await this.perform(endpoint, options);
    if (
      response.status === 401 &&
      options.retryUnauthorized !== false &&
      endpoint.path !== endpoints.auth.refresh.path
    ) {
      const currentAccessToken = this.dependencies.getAccessToken();
      if (currentAccessToken && currentAccessToken !== accessTokenAtRequestStart) {
        response = await this.perform(endpoint, { ...options, retryUnauthorized: false });
      } else if (this.dependencies.getRefreshToken()) {
        await this.refreshOnce();
        response = await this.perform(endpoint, { ...options, retryUnauthorized: false });
      }
    }

    const body = await readResponseBody(response);
    if (!response.ok) throw this.toAppError(response, body);

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

  private async refreshOnce(): Promise<void> {
    if (!this.refreshFlight) {
      this.refreshFlight = this.refresh().finally(() => {
        this.refreshFlight = undefined;
      });
    }
    return this.refreshFlight;
  }

  private async refresh(): Promise<void> {
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
    const { body, timeoutMs = defaultTimeoutMs, signal, routeId, retryUnauthorized, ...init } = options;
    void retryUnauthorized;
    const headers = this.headers(init.headers, true, routeId);
    return this.fetchWithTimeout(
      endpoint.path,
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
      return await this.dependencies.fetch(path, { ...init, signal: controller.signal });
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
      throw new AppError("Gateway에 연결할 수 없습니다.", {
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
}

export const apiClient = new ApiClient();
