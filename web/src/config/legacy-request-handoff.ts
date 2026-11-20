import type { AppRequestsQuery } from "@/shared/api/schemas";
import {
  legacyDirectRequestDestination,
  legacyRequestListDestination,
  type LegacyRequestListDestination,
} from "./legacy-request-map";
import { legacyRoutes } from "./legacy-route-map";

export interface RequestLegacyListContext {
  query: AppRequestsQuery;
  localSearch: boolean;
}

/** Keep list predicates separate from the original detail identity, including through SSO. */
export function legacyRequestHandoff({
  base,
  requestId,
  detailSupported,
  extendedSupported,
  filtersSupported,
  prefixes,
  list,
}: {
  base: string | undefined;
  requestId: string;
  detailSupported: boolean;
  extendedSupported: boolean;
  filtersSupported: boolean;
  prefixes: readonly string[];
  list?: RequestLegacyListContext;
}): LegacyRequestListDestination & { sameRequest: boolean } {
  const detail = legacyDirectRequestDestination(
    base,
    requestId,
    detailSupported,
    extendedSupported,
    prefixes,
  );
  if (!list || !detail.href) return detail;
  let mapped = legacyRequestListDestination(base, list.query, filtersSupported, prefixes);
  let href = mapped.href;
  if (detail.sameRequest && href?.startsWith(legacyRoutes.requests + "?")) {
    const params = new URLSearchParams(href.slice(legacyRoutes.requests.length + 1));
    params.set("request_id", requestId);
    const combined = legacyRoutes.requests + "?" + params;
    // Extended receivers promise a pure selection only. Mixed filters must fit the older SSO limit.
    if (combined.slice("/admin".length).length <= 8192) {
      href = combined as `/admin${string}`;
    } else {
      href = detail.href;
      mapped = legacyRequestListDestination(base, list.query, false, prefixes);
    }
  } else if (detail.sameRequest) {
    href = detail.href;
  }
  const notice = [
    mapped.notice,
    list.localSearch ? "표시된 요청에서 찾은 검색 조건은 기존 화면에 전달되지 않습니다." : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return { href, sameRequest: detail.sameRequest, notice: notice || undefined };
}
