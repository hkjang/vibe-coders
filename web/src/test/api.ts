import { vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import type { ApiEndpointBase } from "@/shared/api/endpoint-factory";
import { AppError } from "@/shared/api/error";

export interface MockedRequestOptions {
  body?: unknown;
  query?: object;
}

export type ApiHandler = (options: MockedRequestOptions, endpoint: ApiEndpointBase) => unknown;

/**
 * Stubs `apiClient.request`. Handlers are keyed by "METHOD /path" (the endpoint's
 * declared path, e.g. "GET /admin/users"); a handler may return a value or a
 * promise, or throw an `AppError`. Unhandled endpoints fail the test loudly.
 */
export function mockApi(handlers: Readonly<Record<string, ApiHandler>>) {
  const calls: Array<{ key: string; options: MockedRequestOptions }> = [];
  const spy = vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, ...args) => {
    const options = (args[0] ?? {}) as MockedRequestOptions;
    const key = `${endpoint.method} ${endpoint.path}`;
    calls.push({ key, options: { body: options.body, query: options.query } });
    const handler = handlers[key];
    if (!handler) {
      throw new AppError(`unmocked API call ${key}`, { kind: "contract", details: options });
    }
    return handler(options, endpoint) as never;
  });
  return {
    spy,
    calls,
    /** Bodies sent to a given endpoint key, in order. */
    bodies(key: string): unknown[] {
      return calls.filter((call) => call.key === key).map((call) => call.options.body);
    },
  };
}

export function apiFailure(message: string, status = 500, requestId = "req_test"): AppError {
  return new AppError(message, {
    kind: status === 403 ? "permission" : status === 401 ? "auth" : "http",
    status,
    requestId,
    retryable: status >= 500,
  });
}
