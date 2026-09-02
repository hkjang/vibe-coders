import type { Provider, ProviderSLO, ProviderSLOEvaluation, RoutingHealth } from "@/shared/api/schemas";

export const providerStatusFilters = [
  "all",
  "enabled",
  "disabled",
  "healthy",
  "degraded",
  "unknown",
] as const;

export type ProviderStatusFilter = (typeof providerStatusFilters)[number];
export type ProviderHealthState = "checking" | "healthy" | "degraded" | "unknown";

export interface ProviderCatalogRow {
  provider: Provider;
  health: ProviderHealthState;
  routing?: RoutingHealth["providers"][number];
  slo?: ProviderSLO;
  evaluation?: ProviderSLOEvaluation;
}

export function isProviderStatusFilter(value: string | null): value is ProviderStatusFilter {
  return value !== null && providerStatusFilters.some((candidate) => candidate === value);
}

export const invalidProviderURLDisplay = "Provider URL을 안전하게 표시할 수 없습니다.";

function providerURLQueryKeyIsSensitive(key: string): boolean {
  const parts = key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const sensitiveTerms = [
    "authorization",
    "credentials",
    "credential",
    "password",
    "passwd",
    "signature",
    "secret",
    "token",
    "auth",
    "sig",
    "key",
  ];
  const containedTerms = ["authorization", "credential", "password", "signature", "secret", "token"];
  if (
    parts.some(
      (part) =>
        sensitiveTerms.some((term) => part.startsWith(term) || part.endsWith(term)) ||
        containedTerms.some((term) => part.includes(term)),
    )
  ) {
    return true;
  }
  return ["apikey", "accesstoken", "authtoken", "bearertoken", "clientsecret", "subscriptionkey"].includes(
    parts.join(""),
  );
}

function parseProviderURL(value: string): URL | undefined {
  const trimmed = value.trim();
  if (
    [...trimmed].some((character) => character.charCodeAt(0) <= 31) ||
    trimmed.includes("\\") ||
    /%(?![\da-f]{2})/i.test(trimmed)
  ) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    if (!/^https?:$/.test(url.protocol) || url.hostname === "") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function displayProviderBaseURL(value: string): string {
  const url = parseProviderURL(value);
  if (!url) return invalidProviderURLDisplay;
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (providerURLQueryKeyIsSensitive(key)) url.searchParams.set(key, "***");
  }
  return url.toString();
}

export function providerSearchContainsSensitiveValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  const parsedURL = parseProviderURL(trimmed);
  if (parsedURL) {
    if (parsedURL.username !== "" || parsedURL.password !== "" || parsedURL.hash !== "") return true;
    if ([...parsedURL.searchParams.keys()].some(providerURLQueryKeyIsSensitive)) return true;
  } else {
    const assignments = trimmed.matchAll(/(?:^|[?&#;\s])([a-z0-9_.-]+)\s*[=:]/gi);
    for (const assignment of assignments) {
      if (providerURLQueryKeyIsSensitive(assignment[1] ?? "")) return true;
    }
  }
  return (
    /\bbearer\s+\S+/i.test(trimmed) ||
    /\bsk-[a-z0-9_-]{8,}/i.test(trimmed) ||
    /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i.test(trimmed)
  );
}

export function buildProviderRows(
  providers: readonly Provider[],
  slos: readonly ProviderSLO[] = [],
  evaluations: readonly ProviderSLOEvaluation[] = [],
  routing?: RoutingHealth,
  healthPending = false,
): ProviderCatalogRow[] {
  const sloByProvider = new Map(slos.map((slo) => [slo.provider, slo]));
  const evaluationByProvider = new Map(evaluations.map((evaluation) => [evaluation.provider, evaluation]));
  const routingByProvider = new Map(routing?.providers.map((health) => [health.provider, health]) ?? []);
  const degradedProviders = new Set(routing?.degraded.map((health) => health.provider) ?? []);

  return providers.map((provider) => {
    const evaluation = evaluationByProvider.get(provider.name);
    const routingHealth = routingByProvider.get(provider.name);
    let health: ProviderHealthState = provider.enabled && healthPending ? "checking" : "unknown";
    if (provider.enabled) {
      if (healthPending) health = "checking";
      else if (routingHealth) health = degradedProviders.has(provider.name) ? "degraded" : "healthy";
      else if (evaluation?.enabled && evaluation.requests > 0) {
        health = evaluation.breached ? "degraded" : "healthy";
      }
    }
    return {
      provider,
      health,
      routing: routingHealth,
      slo: sloByProvider.get(provider.name),
      evaluation,
    };
  });
}

export function filterProviderRows(
  rows: readonly ProviderCatalogRow[],
  query: string,
  status: ProviderStatusFilter,
): ProviderCatalogRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    const matchesQuery =
      normalizedQuery === "" ||
      [
        row.provider.name,
        displayProviderBaseURL(row.provider.base_url),
        row.provider.model_patterns,
        row.provider.failover_group,
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    if (!matchesQuery) return false;
    if (status === "all") return true;
    if (status === "enabled") return row.provider.enabled;
    if (status === "disabled") return !row.provider.enabled;
    if (row.health === "checking") return true;
    return row.health === status;
  });
}
