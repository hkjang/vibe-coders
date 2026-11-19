import type { AppRequestsQuery } from "@/shared/api/schemas";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { fitsUTF8Bytes } from "@/shared/utils/utf8";
import { requestQueryFieldError, type RequestQueryField } from "@/shared/utils/request-query-filters";
import { validateRequestTimeFilters } from "@/shared/utils/request-time-filters";
import { legacyRoutes, isLegacyAdminHref } from "./legacy-route-map";

const filterLabels = {
  ip: "클라이언트 IP",
  model: "모델",
  language: "언어",
  from: "시작 시각",
  to: "종료 시각",
  tz: "시간대",
  limit: "표시 건수",
  status: "상태",
  provider_ref: "공급자 참조",
  request_id: "요청 ID",
  trace_id: "추적 ID",
  session_id: "세션 ID",
  api_key_id: "API 키 ID",
  cursor: "페이지 위치",
} satisfies Record<RequestQueryField, string>;
const supportedFilters = new Set<RequestQueryField>(["ip", "model", "language", "from", "to", "tz", "limit"]);

export interface LegacyRequestListDestination {
  href?: `/admin${string}`;
  notice?: string;
}

/** Map only known Legacy list predicates. request_id on Legacy selects a detail, never a list filter. */
export function legacyRequestListDestination(
  baseHref: string | undefined,
  query: AppRequestsQuery,
  filtersSupported: boolean,
  credentialPrefixes: readonly string[],
): LegacyRequestListDestination {
  if (!isLegacyAdminHref(baseHref) || containsPotentialSecret(baseHref, credentialPrefixes)) return {};
  const enabled = filtersSupported && baseHref === legacyRoutes.requests;
  const params = new URLSearchParams();
  const omitted: string[] = [];
  const temporalError = validateRequestTimeFilters(query);
  for (const key of Object.keys(filterLabels) as RequestQueryField[]) {
    const value = query[key];
    if (value === undefined || value === "") continue;
    if (key === "tz" && !query.from && !query.to) continue;
    const text = String(value);
    const temporal = key === "from" || key === "to" || key === "tz";
    let safe = !requestQueryFieldError(key, text) && !containsPotentialSecret(text, credentialPrefixes);
    try {
      encodeURIComponent(text);
    } catch {
      safe = false;
    }
    safe = safe && isLegacyAdminHref(legacyRoutes.requests + "?" + new URLSearchParams({ [key]: text }));
    if (enabled && supportedFilters.has(key) && safe && !(temporal && temporalError)) {
      params.set(key, text);
    } else {
      omitted.push(filterLabels[key]);
    }
  }
  return {
    href: (params.size ? baseHref + "?" + params.toString() : baseHref) as `/admin${string}`,
    notice: omitted.length
      ? `기존 화면에서는 다음 조회 조건이 유지되지 않습니다: ${omitted.join(", ")}. 첫 페이지부터 조회합니다.`
      : undefined,
  };
}

/** Only the known requests screen supports this ID handoff; opaque refs are never raw IDs. */
export function legacyRequestDetailHref(
  baseHref: string | undefined,
  request: { request_id: string; request_filterable: boolean } | undefined,
  credentialPrefixes: readonly string[],
  listDestination?: LegacyRequestListDestination,
): `/admin${string}` | undefined {
  if (baseHref !== legacyRoutes.requests || request?.request_filterable !== true) return undefined;
  const id = request.request_id;
  if (
    !id ||
    id.trim() !== id ||
    !fitsUTF8Bytes(id, 512) ||
    [".", "..", "diff", "io"].includes(id) ||
    /[/\\\p{Cc}]/u.test(id) ||
    containsPotentialSecret(id, credentialPrefixes)
  )
    return undefined;
  try {
    // URI encoding rejects lone surrogates rather than silently changing the identity.
    encodeURIComponent(id);
    const params = new URLSearchParams();
    const listHref = listDestination?.href;
    if (listHref?.startsWith(legacyRoutes.requests + "?")) {
      const mapped = new URLSearchParams(listHref.slice(legacyRoutes.requests.length + 1));
      for (const [key, value] of mapped) {
        if (supportedFilters.has(key as RequestQueryField)) params.set(key, value);
      }
    }
    params.set("request_id", id);
    const href = legacyRoutes.requests + "?" + params.toString();
    return isLegacyAdminHref(href) && !containsPotentialSecret(href, credentialPrefixes) ? href : undefined;
  } catch {
    return undefined;
  }
}
