import {
  containsConfiguredCredential,
  containsPotentialSecret,
  defaultCredentialPrefixes,
  isSensitiveCredentialKey,
} from "@/shared/security/secrets";
import { isAppRequestRef } from "@/shared/api/app-request-ref";
import { validateRequestTimeFilters } from "@/shared/utils/request-time-filters";
import { isOpaqueAppRequestCursor, isValidRequestQueryField } from "@/shared/utils/request-query-filters";
import { isProviderRef } from "@/shared/api/provider-ref";

const routeQueryAllowlist: Readonly<Record<string, ReadonlySet<string>>> = {
  "/login": new Set(["return_to"]),
  "/providers": new Set(["page", "provider", "q", "range", "status"]),
  "/models": new Set(["model", "model_provider", "page", "provider", "q", "range", "source", "status"]),
  "/gateway/providers": new Set(["page", "provider", "q", "range", "status"]),
  "/gateway/models": new Set([
    "model",
    "model_provider",
    "page",
    "provider",
    "q",
    "range",
    "source",
    "status",
  ]),
  "/overview": new Set(["range"]),
  "/gateway/health": new Set(["range"]),
  "/routing/rules": new Set(["page"]),
  "/observability/requests": new Set([
    "api_key_id",
    "cursor",
    "from",
    "ip",
    "language",
    "limit",
    "model",
    "provider_ref",
    "request_id",
    "session_id",
    "status",
    "to",
    "trace_id",
    "tz",
  ]),
  "/observability/traces": new Set([
    "cursor",
    "from",
    "limit",
    "model",
    "selected_ref",
    "selected_request",
    "status",
    "to",
    "trace_id",
    "tz",
  ]),
  "/system/health": new Set(["range"]),
};

export const sensitiveQueryRejectionStateKey = "appSensitiveQueryKeys";
const preservedRejectionKeys = new Set(["q"]);
const preservedBooleanStateKeys = ["providerDetailRejected", "providerSearchRejected"] as const;

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
  const allowed = routeQueryAllowlist[routerPath(pathname)] ?? new Set<string>();
  const rejectedKeys = new Set<string>();
  const sensitiveKeys = new Set<string>();
  const rejectedValues = new Map<string, boolean>();
  const route = routerPath(pathname);
  const invalidOperationalKeys = new Set<string>();
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
