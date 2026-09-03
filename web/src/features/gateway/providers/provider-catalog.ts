import type { Provider, ProviderSLO, ProviderSLOEvaluation, RoutingHealth } from "@/shared/api/schemas";
import { isSafeLegacyProviderName, providerDisplayLabels } from "@/shared/api/provider-ref";
import { containsPotentialSecret, isSensitiveCredentialKey } from "@/shared/security/secrets";

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
  displayName: string;
  provider: Provider;
  health: ProviderHealthState;
  identity: string;
  nameRedacted: boolean;
  routing?: RoutingHealth["providers"][number];
  slo?: ProviderSLO;
  evaluation?: ProviderSLOEvaluation;
}

export function isProviderStatusFilter(value: string | null): value is ProviderStatusFilter {
  return value !== null && providerStatusFilters.some((candidate) => candidate === value);
}

export const invalidProviderURLDisplay = "공급자 URL을 안전하게 표시할 수 없습니다.";

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
    if (isSensitiveCredentialKey(key)) url.searchParams.set(key, "***");
  }
  return url.toString();
}

export function providerSearchContainsSensitiveValue(value: string): boolean {
  return containsPotentialSecret(value);
}

export function buildProviderRows(
  providers: readonly Provider[],
  slos: readonly ProviderSLO[] = [],
  evaluations: readonly ProviderSLOEvaluation[] = [],
  routing?: RoutingHealth,
  healthPending = false,
): ProviderCatalogRow[] {
  const sloByProvider = new Map(slos.map((item) => [item.provider_ref, item]));
  const evaluationByProvider = new Map(evaluations.map((item) => [item.provider_ref, item]));
  const routingByProvider = new Map(routing?.providers.map((item) => [item.provider_ref, item]) ?? []);
  const degradedProviders = new Set(routing?.degraded.map((item) => item.provider_ref) ?? []);
  const displayLabels = providerDisplayLabels(
    providers.map((provider) => ({ name: provider.name, providerRef: provider.provider_ref })),
  );

  return providers.map((provider) => {
    const nameRedacted = !isSafeLegacyProviderName(provider.name);
    const displayName = displayLabels.get(provider.provider_ref) ?? "공급자 확인 불가";
    const evaluation = evaluationByProvider.get(provider.provider_ref);
    const providerSlo = sloByProvider.get(provider.provider_ref);
    const routingHealth = routingByProvider.get(provider.provider_ref);
    let health: ProviderHealthState = provider.enabled && healthPending ? "checking" : "unknown";
    if (provider.enabled) {
      if (healthPending) health = "checking";
      else if (routingHealth) health = degradedProviders.has(provider.provider_ref) ? "degraded" : "healthy";
      else if (evaluation?.enabled && evaluation.requests > 0) {
        health = evaluation.breached ? "degraded" : "healthy";
      }
    }
    return {
      displayName,
      provider: nameRedacted ? { ...provider, name: displayName } : provider,
      health,
      identity: provider.provider_ref,
      nameRedacted,
      routing: routingHealth ? { ...routingHealth, provider: displayName } : undefined,
      slo: providerSlo ? { ...providerSlo, provider: displayName } : undefined,
      evaluation: evaluation ? { ...evaluation, provider: displayName } : undefined,
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
        row.displayName,
        displayProviderBaseURL(row.provider.base_url),
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
