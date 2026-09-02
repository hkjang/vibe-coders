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

export function sanitizeAppRouteHash(hash: string): string {
  return hash !== "" && containsPotentialSecret(hash.slice(1)) ? "" : hash;
}

export function locationStateWithSensitiveRejections(
  state: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (keys.length === 0) return typeof state === "object" && state !== null ? { ...state } : null;
  const current = typeof state === "object" && state !== null ? state : {};
  return { ...current, [sensitiveQueryRejectionStateKey]: [...new Set(keys)] };
}

export function rejectedSensitiveQuery(locationState: unknown, key: string): boolean {
  if (typeof locationState !== "object" || locationState === null) return false;
  const keys = (locationState as Record<string, unknown>)[sensitiveQueryRejectionStateKey];
  return Array.isArray(keys) && keys.some((candidate) => candidate === key);
}

export function sanitizeWindowAppLocationBeforeBootstrap(): void {
  const result = sanitizeAppRouteSearch(window.location.pathname, window.location.search);
  const hash = sanitizeAppRouteHash(window.location.hash);
  if (result.search === window.location.search && hash === window.location.hash) return;

  const historyState =
    typeof window.history.state === "object" && window.history.state !== null
      ? (window.history.state as Record<string, unknown>)
      : {};
  const routerState = locationStateWithSensitiveRejections(historyState.usr, result.sensitiveKeys);
  const nextState = { ...historyState, usr: routerState };
  window.history.replaceState(nextState, "", `${window.location.pathname}${result.search}${hash}`);
}
