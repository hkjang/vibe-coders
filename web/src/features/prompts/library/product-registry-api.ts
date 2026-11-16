import { apiClient } from "@/shared/api/client";
import {
  productRegistryEndpoint,
  productMetadataPageSchema,
  type ProductMetadataQuery,
} from "@/shared/api/domains/prompt-products";
import { libraryError, libraryRouteId, projectLibrary } from "./library-model";

export async function readProductMetadata(
  query: ProductMetadataQuery,
  prefixes: readonly string[],
  signal: AbortSignal,
) {
  const response = await apiClient.request(productRegistryEndpoint, {
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
    response.items.some(
      (item) =>
        (query.state !== "all" && item.template_state !== query.state) ||
        (item.template_state === "missing" && (item.use_count !== null || item.last_used_at !== null)),
    ) ||
    (response.items.length > 0 && response.total < query.offset + response.items.length)
  )
    throw libraryError();
  return projectLibrary(productMetadataPageSchema, response, prefixes);
}
