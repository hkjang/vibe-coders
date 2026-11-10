import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import type { RequestDetailReadScope } from "@/features/observability/request-insight/request-detail-read-scope";
import { apiClient } from "@/shared/api/client";
import type { RequestIOCapture, RequestIOPreview } from "@/shared/api/domains/observability.schemas";
import { endpoints } from "@/shared/api/endpoints";

const maxIdsPerRead = 100;

interface PreviewCache {
  scope: object;
  previews: ReadonlyMap<string, RequestIOPreview | null>;
  capture?: RequestIOCapture;
}
const empty: ReadonlyMap<string, RequestIOPreview | null> = new Map();

/**
 * Masked input and output previews for a list of requests. Request rows do not change once
 * logged, so each is fetched once. The cache belongs to one read scope: a change of account
 * starts empty, never from these rows.
 */
export function useRequestIOPreviews(
  ids: readonly string[],
  scope: RequestDetailReadScope,
  enabled: boolean,
  routeId: string,
) {
  const [cache, setCache] = useState<PreviewCache>({ scope, previews: new Map() });
  const previews = cache.scope === scope ? cache.previews : empty;
  const capture = cache.scope === scope ? cache.capture : undefined;
  const missing = useMemo(
    () => ids.filter((id) => !previews.has(id)).slice(0, maxIdsPerRead),
    [ids, previews],
  );
  const query = useQuery({
    queryKey: ["observability", "io", "previews", scope.id, missing],
    enabled: enabled && missing.length > 0,
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await apiClient.request(endpoints.domains.observability.requests.ioPreviews, {
        query: { ids: missing.join(",") },
        signal,
        routeId,
      });
      if (scope.isCurrent()) {
        setCache((current) => {
          const next = new Map(current.scope === scope ? current.previews : empty);
          // An id the server omitted is out of scope or gone; remember that so it is not re-asked.
          for (const id of missing) if (!next.has(id)) next.set(id, null);
          for (const preview of result.previews) next.set(preview.request_id, preview);
          return { scope, previews: next, capture: result.capture };
        });
      }
      return result;
    },
  });
  return { previews, capture, failed: query.isError };
}
