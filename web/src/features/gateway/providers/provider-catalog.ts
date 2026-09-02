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
export type ProviderHealthState = "healthy" | "degraded" | "unknown";

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

export function displayProviderBaseURL(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    for (const key of url.searchParams.keys()) {
      if (/(?:api[-_]?key|password|secret|signature|token)/i.test(key)) {
        url.searchParams.set(key, "***");
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function buildProviderRows(
  providers: readonly Provider[],
  slos: readonly ProviderSLO[] = [],
  evaluations: readonly ProviderSLOEvaluation[] = [],
  routing?: RoutingHealth,
): ProviderCatalogRow[] {
  const sloByProvider = new Map(slos.map((slo) => [slo.provider, slo]));
  const evaluationByProvider = new Map(evaluations.map((evaluation) => [evaluation.provider, evaluation]));
  const routingByProvider = new Map(routing?.providers.map((health) => [health.provider, health]) ?? []);
  const degradedProviders = new Set(routing?.degraded.map((health) => health.provider) ?? []);

  return providers.map((provider) => {
    const evaluation = evaluationByProvider.get(provider.name);
    const routingHealth = routingByProvider.get(provider.name);
    let health: ProviderHealthState = "unknown";
    if (provider.enabled) {
      if (routingHealth) health = degradedProviders.has(provider.name) ? "degraded" : "healthy";
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
        row.provider.base_url,
        row.provider.model_patterns,
        row.provider.failover_group,
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    if (!matchesQuery) return false;
    if (status === "all") return true;
    if (status === "enabled") return row.provider.enabled;
    if (status === "disabled") return !row.provider.enabled;
    return row.health === status;
  });
}
