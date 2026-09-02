import { containsPotentialSecret, isSensitiveCredentialKey } from "@/shared/security/secrets";

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
  "/system/health": new Set(["range"]),
};

export const sensitiveQueryRejectionStateKey = "appSensitiveQueryKeys";
const preservedRejectionKeys = new Set(["q"]);

export interface SanitizedAppRouteSearch {
  rejectedKeys: readonly string[];
  sensitiveKeys: readonly string[];
  search: string;
}

function routerPath(pathname: string): string {
  const withoutBase = pathname === "/app" ? "/" : pathname.replace(/^\/app(?=\/)/, "");
  return withoutBase.length > 1 ? withoutBase.replace(/\/+$/, "") : withoutBase;
}

function sensitiveParameter(key: string, values: readonly string[]): boolean {
  return isSensitiveCredentialKey(key) || values.some(containsPotentialSecret);
}

export function sanitizeAppRouteSearch(pathname: string, search: string): SanitizedAppRouteSearch {
  const parameters = new URLSearchParams(search);
  const allowed = routeQueryAllowlist[routerPath(pathname)] ?? new Set<string>();
  const rejectedKeys = new Set<string>();
  const sensitiveKeys = new Set<string>();
  const rejectedValues = new Map<string, boolean>();

  for (const key of new Set(parameters.keys())) {
    const values = parameters.getAll(key);
    const sensitive = sensitiveParameter(key, values);
    rejectedValues.set(key, sensitive);
    if (!allowed.has(key) || sensitive) {
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

export function sanitizeAppRouteHash(hash: string, pathname = ""): string {
  const ssoHash = sanitizedLoginSsoHash(hash, pathname);
  if (ssoHash !== undefined) return ssoHash;
  return hash !== "" && containsPotentialSecret(hash.slice(1)) ? "" : hash;
}

export function locationStateWithSensitiveRejections(
  state: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  const existing =
    typeof state === "object" && state !== null
      ? (state as Record<string, unknown>)[sensitiveQueryRejectionStateKey]
      : undefined;
  const safeKeys = new Set<string>();
  if (Array.isArray(existing)) {
    for (const key of existing) {
      if (typeof key === "string" && preservedRejectionKeys.has(key)) safeKeys.add(key);
    }
  }
  for (const key of keys) {
    if (preservedRejectionKeys.has(key)) safeKeys.add(key);
  }
  return safeKeys.size > 0 ? { [sensitiveQueryRejectionStateKey]: [...safeKeys] } : null;
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
  const entries = Object.entries(state);
  if (entries.length !== 1 || entries[0]?.[0] !== sensitiveQueryRejectionStateKey) return false;
  const actual = entries[0][1];
  const expected = safeState[sensitiveQueryRejectionStateKey];
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
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
