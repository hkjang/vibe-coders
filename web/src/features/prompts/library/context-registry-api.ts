import { apiClient } from "@/shared/api/client";
import {
  contextRegistryEndpoint,
  contextMetadataPageSchema,
  type ContextMetadataQuery,
} from "@/shared/api/domains/context-registry";
import { libraryError, libraryRouteId, projectLibrary } from "./library-model";

export async function readContextMetadata(
  query: ContextMetadataQuery,
  prefixes: readonly string[],
  signal: AbortSignal,
) {
  const response = await apiClient.request(contextRegistryEndpoint, {
    query,
    signal,
    cache: "no-store",
    routeId: libraryRouteId,
  });
  if (
    response.offset !== query.offset ||
    response.limit !== query.limit ||
    response.state !== query.state ||
    response.items.length > query.limit ||
    response.items.some((item) => query.state !== "all" && item.enabled !== (query.state === "enabled")) ||
    (response.items.length > 0 && response.total < query.offset + response.items.length)
  )
    throw libraryError();
  return projectLibrary(contextMetadataPageSchema, response, prefixes);
}
