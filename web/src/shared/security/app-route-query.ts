import { directRequestSelection } from "@/config/legacy-request-map";
import { validTraceTimelineView } from "@/shared/utils/trace-timeline-query";
import { validSessionPageValue } from "@/shared/utils/session-page-query";
import { traceRelatedQueryKeys, validTraceRelatedQueryValue } from "@/shared/utils/trace-related-query";
import { runQueryKeys, validRunSort } from "@/shared/utils/redteam-run-query";
import { validContextSort } from "@/shared/utils/context-registry-query";
import {
  containsConfiguredCredential,
  containsPotentialSecret,
  defaultCredentialPrefixes,
  isSensitiveCredentialKey,
} from "@/shared/security/secrets";
import { isAppRequestRef } from "@/shared/api/app-request-ref";
import { validateRequestTimeFilters } from "@/shared/utils/request-time-filters";
import { isOpaqueAppRequestCursor, isValidRequestQueryField } from "@/shared/utils/request-query-filters";
import { isSkillRef } from "@/shared/api/skill-ref";
import { isProviderRef } from "@/shared/api/provider-ref";
import { featureQueryKeys } from "@/features/registry";
import { domainDecisionRequestIDError } from "@/shared/utils/domain-decision-filters";
import { readModelCatalogPageSize, readModelCatalogSorting } from "@/shared/utils/model-catalog-query";
import { isValidTraceStepFilter } from "@/shared/utils/trace-step-query";
import {
  readProviderCatalogPageSize,
  readProviderCatalogSorting,
} from "@/shared/utils/provider-catalog-query";

const routeQueryAllowlist: Readonly<Record<string, ReadonlySet<string>>> = {
  // Screens declare their own query keys next to their route registration; this
  // map covers the routes no feature module owns: the login screen and the two
  // compatibility redirects that forward to the gateway catalog screens.
  "/login": new Set(["return_to", "sso"]),
  "/providers": new Set(["page", "provider", "q", "range", "status", "sort", "page_size"]),
  "/models": new Set([
    "model",
    "model_provider",
    "page",
    "provider",
    "q",
    "range",
    "source",
    "status",
    "sort",
    "page_size",
  ]),
};

export const sensitiveQueryRejectionStateKey = "appSensitiveQueryKeys";
const preservedRejectionKeys = new Set([
  "q",
  "team",
  "contexts_q",
  "contexts_sort",
  "console_q",
  "console_status",
  "console_readonly",
  ...runQueryKeys,
]);
const preservedBooleanStateKeys = [
  "providerDetailRejected",
  "providerSearchRejected",
  "policyTabFocus",
  "accessTabFocus",
] as const;

export interface SanitizedAppRouteSearch {
  rejectedKeys: readonly string[];
  sensitiveKeys: readonly string[];
  search: string;
}

function routerPath(pathname: string): string {
  const withoutBase = pathname === "/app" ? "/" : pathname.replace(/^\/app(?=\/)/, "");
  return withoutBase.length > 1 ? withoutBase.replace(/\/+$/, "") : withoutBase;
}

function sensitiveParameter(
  key: string,
  values: readonly string[],
  credentialPrefixes: readonly string[],
): boolean {
  // request_ref values are server-issued keyed references. Their segmented,
  // exact-length contract deliberately takes precedence over configurable and
  // generic credential heuristics so a prefix such as `req_`, or an incidental
  // `sk-` substring, cannot break safe request-detail navigation.
  if (key === "selected_ref" && values.every(isAppRequestRef)) return false;
  if (key === "skill_ref" && values.every(isSkillRef)) return false;
  // This bounded enum grammar contains only column ids and directions. The
  // registry column named key is not an assigned credential.
  if (key === "runs_sort" && values.length === 1 && validRunSort(values[0] ?? "")) return false;
  if (key === "contexts_sort" && values.length === 1 && validContextSort(values[0] ?? "")) return false;
  if (values.some((value) => containsConfiguredCredential(value, credentialPrefixes))) return true;
  if (key === "provider_ref" && values.every(isProviderRef)) return false;
  if (key === "cursor" && values.every(isOpaqueAppRequestCursor)) return false;
  // api_key_id is a database identifier used for request filtering, not an API
  // credential. Preserve only its bounded identifier form; actual key material
  // remains rejected by both the character contract and secret scanner.
  if (
    key === "api_key_id" &&
    values.every(
      (value) => /^[a-z0-9._:-]{1,512}$/iu.test(value) && !containsPotentialSecret(value, credentialPrefixes),
    )
  ) {
    return false;
  }
  return (
    isSensitiveCredentialKey(key) ||
    values.some((value) => containsPotentialSecret(value, credentialPrefixes))
  );
}

export function sanitizeAppRouteSearch(
  pathname: string,
  search: string,
  credentialPrefixes: readonly string[] = defaultCredentialPrefixes,
): SanitizedAppRouteSearch {
  const parameters = new URLSearchParams(search);
  // Screens declare their own query keys next to their route registration; the
  // static map above covers the login screen and compatibility redirects.
  // A screen's own declaration wins: the static map above must never shadow the
  // keys a feature registered, or its filters are silently stripped from the URL.
  const allowed =
    featureQueryKeys(routerPath(pathname)) ?? routeQueryAllowlist[routerPath(pathname)] ?? new Set<string>();
  const rejectedKeys = new Set<string>();
  const sensitiveKeys = new Set<string>();
  const rejectedValues = new Map<string, boolean>();
  const route = routerPath(pathname);
  const invalidOperationalKeys = new Set<string>();
  const ioSelection =
    route === "/observability/io" ? directRequestSelection(search, credentialPrefixes) : undefined;
  if (ioSelection?.present && !ioSelection.id) invalidOperationalKeys.add("request_id");

  // These are gateway-owned refusal markers, not arbitrary provider errors.
  // Keep one bounded outcome through both startup and client-side navigation.
  if (route === "/login" && parameters.has("sso")) {
    const values = parameters.getAll("sso");
    if (values.length !== 1 || !["none", "error"].includes(values[0] ?? "")) {
      invalidOperationalKeys.add("sso");
    }
  }
  if (route === "/observability/traces" || route.startsWith("/observability/traces/")) {
    if (
      parameters.has("timeline_view") &&
      (route !== "/observability/traces" || !validTraceTimelineView(parameters.getAll("timeline_view")))
    )
      invalidOperationalKeys.add("timeline_view");
    for (const key of traceRelatedQueryKeys) {
      if (
        parameters.has(key) &&
        (route !== "/observability/traces" || !validTraceRelatedQueryValue(key, parameters.getAll(key)))
      )
        invalidOperationalKeys.add(key);
    }
    for (const key of ["flow_kind", "flow_status"] as const) {
      if (
        parameters.has(key) &&
        (route !== "/observability/traces" || !isValidTraceStepFilter(key, parameters.getAll(key)))
      )
        invalidOperationalKeys.add(key);
    }
  }
  if (route === "/observability/sessions") {
    for (const key of ["page_size", "offset"]) {
      if (parameters.has(key) && !validSessionPageValue(key, parameters.getAll(key)))
        invalidOperationalKeys.add(key);
    }
  }
  // Refuse the entire selection before stripping credentials: removing only a
  // competing name could otherwise turn an ambiguous URL into a valid ref.
  if (route === "/agents/skills" && parameters.has("skill_ref")) {
    const references = parameters.getAll("skill_ref");
    if (references.length !== 1 || !isSkillRef(references[0]) || parameters.has("skill")) {
      invalidOperationalKeys.add("skill_ref");
      invalidOperationalKeys.add("skill");
    }
  }
  if (route === "/overview" && parameters.has("trend")) {
    const values = parameters.getAll("trend");
    if (values.length !== 1 || !["1h", "24h", "7d", "30d"].includes(values[0] ?? "")) {
      invalidOperationalKeys.add("trend");
    }
  }
  if (route === "/providers" || route === "/gateway/providers" || route.startsWith("/gateway/providers/")) {
    const exactCatalogueRoute = route === "/providers" || route === "/gateway/providers";
    if (
      parameters.has("sort") &&
      (!exactCatalogueRoute || !readProviderCatalogSorting(parameters.getAll("sort")))
    )
      invalidOperationalKeys.add("sort");
    if (
      parameters.has("page_size") &&
      (!exactCatalogueRoute || !readProviderCatalogPageSize(parameters.getAll("page_size")))
    )
      invalidOperationalKeys.add("page_size");
  }
  if (route === "/models" || route === "/gateway/models" || route.startsWith("/gateway/models/")) {
    const exactCatalogueRoute = route === "/models" || route === "/gateway/models";
    if (
      parameters.has("sort") &&
      (!exactCatalogueRoute || !readModelCatalogSorting(parameters.getAll("sort")))
    )
      invalidOperationalKeys.add("sort");
    if (
      parameters.has("page_size") &&
      (!exactCatalogueRoute || !readModelCatalogPageSize(parameters.getAll("page_size")))
    )
      invalidOperationalKeys.add("page_size");
  }
  if (route === "/routing/rules" || route.startsWith("/routing/rules/")) {
    const requestIDs = parameters.getAll("request_id");
    if (
      requestIDs.length > 0 &&
      (route !== "/routing/rules/learning" ||
        requestIDs.length !== 1 ||
        domainDecisionRequestIDError(requestIDs[0] ?? "") !== undefined)
    ) {
      invalidOperationalKeys.add("request_id");
    }
  }
  if (route === "/observability/requests" || route === "/observability/traces") {
    const requestFields =
      route === "/observability/requests"
        ? ([
            "from",
            "to",
            "tz",
            "status",
            "model",
            "provider_ref",
            "request_id",
            "trace_id",
            "session_id",
            "api_key_id",
            "ip",
            "language",
            "limit",
            "cursor",
          ] as const)
        : (["from", "to", "tz", "status", "model", "trace_id", "limit", "cursor"] as const);
    for (const key of requestFields) {
      const values = parameters.getAll(key);
      if (values.length > 1 || (values.length === 1 && !isValidRequestQueryField(key, values[0] ?? ""))) {
        invalidOperationalKeys.add(key);
      }
    }
    const selectedRequests = parameters.getAll("selected_request");
    const selectedRefs = parameters.getAll("selected_ref");
    const hasAmbiguousSelection = selectedRequests.length > 0 && selectedRefs.length > 0;
    if (
      route === "/observability/traces" &&
      (hasAmbiguousSelection ||
        selectedRequests.length > 1 ||
        (selectedRequests.length === 1 && !isValidRequestQueryField("request_id", selectedRequests[0] ?? "")))
    ) {
      invalidOperationalKeys.add("selected_request");
    }
    if (
      route === "/observability/traces" &&
      (hasAmbiguousSelection ||
        selectedRefs.length > 1 ||
        (selectedRefs.length === 1 && !isAppRequestRef(selectedRefs[0])))
    ) {
      invalidOperationalKeys.add("selected_ref");
    }
    const temporalError = validateRequestTimeFilters({
      from: parameters.get("from") ?? undefined,
      to: parameters.get("to") ?? undefined,
      tz: parameters.get("tz") ?? undefined,
    });
    if (temporalError) invalidOperationalKeys.add(temporalError.field);
  }

  for (const key of new Set(parameters.keys())) {
    const values = parameters.getAll(key);
    const sensitive = sensitiveParameter(key, values, credentialPrefixes);
    const rejected = sensitive || invalidOperationalKeys.has(key);
    rejectedValues.set(key, rejected);
    if (!allowed.has(key) || rejected) {
      rejectedKeys.add(key);
      if (sensitive) sensitiveKeys.add(key);
    }
  }

  const sanitized = new URLSearchParams();
  for (const [key, value] of parameters) {
    if (allowed.has(key) && !rejectedValues.get(key)) sanitized.append(key, value);
  }
  // Keep only an empty refusal marker: dropping an explicit invalid/secret ID
  // would let the IO page silently select a different first-row request.
  if (ioSelection?.present && !ioSelection.id) sanitized.set("request_id", "");
  const serialized = sanitized.toString();
  return {
    rejectedKeys: [...rejectedKeys],
    sensitiveKeys: [...sensitiveKeys],
    search: serialized ? `?${serialized}` : "",
  };
}

function sanitizedLoginSsoHash(hash: string, pathname: string): string | undefined {
  if (routerPath(pathname) !== "/login" || hash === "") return undefined;
  const parameters = new URLSearchParams(hash.slice(1));
  const ssoKeys = ["kc_code", "kc_error", "kc_access", "kc_refresh"] as const;
  if (!ssoKeys.some((key) => parameters.has(key))) return undefined;

  const sanitized = new URLSearchParams();
  const codes = parameters.getAll("kc_code");
  const code = codes.length === 1 ? codes[0]?.trim() : undefined;
  const codeIsSafe =
    code !== undefined &&
    code !== "" &&
    code.length <= 4_096 &&
    !code.includes("\\") &&
    ![...code].some((character) => character.charCodeAt(0) <= 31);
  if (codeIsSafe) sanitized.set("kc_code", code);
  const errors = parameters.getAll("kc_error");
  const error = errors.length === 1 ? errors[0]?.trim() : undefined;
  if (error && /^[a-z0-9_.-]{1,128}$/i.test(error)) sanitized.set("kc_error", error);
  if (parameters.has("kc_access")) sanitized.set("kc_access", "");
  if (parameters.has("kc_refresh")) sanitized.set("kc_refresh", "");
  const serialized = sanitized.toString();
  return serialized ? `#${serialized}` : "";
}

export function sanitizeAppRouteHash(
  hash: string,
  pathname = "",
  credentialPrefixes: readonly string[] = defaultCredentialPrefixes,
): string {
  const ssoHash = sanitizedLoginSsoHash(hash, pathname);
  if (ssoHash !== undefined) return ssoHash;
  return hash !== "" && containsPotentialSecret(hash.slice(1), credentialPrefixes) ? "" : hash;
}

export function locationStateWithSensitiveRejections(
  state: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  const stateRecord =
    typeof state === "object" && state !== null ? (state as Record<string, unknown>) : undefined;
  const existing = stateRecord === undefined ? undefined : stateRecord[sensitiveQueryRejectionStateKey];
  const safeKeys = new Set<string>();
  if (Array.isArray(existing)) {
    for (const key of existing) {
      if (typeof key === "string" && preservedRejectionKeys.has(key)) safeKeys.add(key);
    }
  }
  for (const key of keys) {
    if (preservedRejectionKeys.has(key)) safeKeys.add(key);
  }
  const safeState: Record<string, unknown> = {};
  if (safeKeys.size > 0) safeState[sensitiveQueryRejectionStateKey] = [...safeKeys];
  for (const key of preservedBooleanStateKeys) {
    if (stateRecord?.[key] === true) safeState[key] = true;
  }
  return Object.keys(safeState).length > 0 ? safeState : null;
}

export function rejectedSensitiveQuery(locationState: unknown, key: string): boolean {
  if (typeof locationState !== "object" || locationState === null) return false;
  const keys = (locationState as Record<string, unknown>)[sensitiveQueryRejectionStateKey];
  return Array.isArray(keys) && keys.some((candidate) => candidate === key);
}

export function isSanitizedAppLocationState(
  state: unknown,
  safeState: Record<string, unknown> | null,
): boolean {
  if (safeState === null) return state === null || state === undefined;
  if (typeof state !== "object" || state === null) return false;
  const stateRecord = state as Record<string, unknown>;
  const entries = Object.entries(stateRecord);
  const expectedEntries = Object.entries(safeState);
  if (entries.length !== expectedEntries.length) return false;
  return expectedEntries.every(([key, expected]) => {
    const actual = stateRecord[key];
    if (!Array.isArray(expected)) return actual === expected;
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index])
    );
  });
}

export function sanitizeWindowAppLocationBeforeBootstrap(): void {
  const result = sanitizeAppRouteSearch(window.location.pathname, window.location.search);
  const hash = sanitizeAppRouteHash(window.location.hash, window.location.pathname);

  const historyState =
    typeof window.history.state === "object" && window.history.state !== null
      ? (window.history.state as Record<string, unknown>)
      : {};
  const nextState: Record<string, unknown> = {};
  if (Number.isInteger(historyState.idx) && Number(historyState.idx) >= 0) {
    nextState.idx = historyState.idx;
  }
  if (
    typeof historyState.key === "string" &&
    /^[a-z0-9_-]{1,64}$/i.test(historyState.key) &&
    !containsPotentialSecret(historyState.key)
  ) {
    nextState.key = historyState.key;
  }
  nextState.usr = locationStateWithSensitiveRejections(historyState.usr, result.sensitiveKeys);
  window.history.replaceState(nextState, "", `${window.location.pathname}${result.search}${hash}`);
}
