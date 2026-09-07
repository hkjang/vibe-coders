import { pathWithParams } from "@/shared/api/endpoint-factory";
import type { OpenApiPath } from "@/shared/api/generated/paths.gen";

/**
 * Binds path parameters on a declared endpoint so the client still sees the same
 * branded endpoint object (and its zod schema) with a concrete URL.
 */
export function withPathParams<Endpoint extends { readonly path: OpenApiPath }>(
  endpoint: Endpoint,
  params: Readonly<Record<string, string | number>>,
): Endpoint {
  return { ...endpoint, path: pathWithParams(endpoint.path, params) };
}
