import type { Provider, ProviderSLO, ProviderSLOEvaluation, RoutingHealth } from "@/shared/api/schemas";
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

const redactedRoutingProviderName = "[provider-name-omitted]";
const redactedProviderIdentities = new WeakMap<Provider, string>();
let fallbackIdentitySequence = 0;

function providerNameSafe(name: string): boolean {
  if (
    name === "" ||
    name === redactedRoutingProviderName ||
    name.trim() !== name ||
    name.includes(",") ||
    [...name].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    }) ||
    containsPotentialSecret(name)
  ) {
    return false;
  }
  return name.length <= 256 && new TextEncoder().encode(name).byteLength <= 256;
}

function randomIdentitySuffix(): string {
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(4);
    globalThis.crypto.getRandomValues(values);
    return [...values].map((value) => value.toString(16).padStart(8, "0")).join("");
  }
  fallbackIdentitySequence += 1;
  return `${Date.now().toString(36)}-${fallbackIdentitySequence.toString(36)}`;
}

const redactedProviderSession = randomIdentitySuffix();
let redactedProviderSequence = 0;

function redactedProviderIdentity(provider: Provider, occupied: Set<string>): string {
  const current = redactedProviderIdentities.get(provider);
  if (current && !occupied.has(current)) {
    occupied.add(current);
    return current;
  }
  let identity: string;
  do {
    redactedProviderSequence += 1;
    identity = `redacted-provider-${redactedProviderSession}-${redactedProviderSequence.toString(36)}`;
  } while (occupied.has(identity));
  redactedProviderIdentities.set(provider, identity);
  occupied.add(identity);
  return identity;
}

export function isProviderStatusFilter(value: string | null): value is ProviderStatusFilter {
  return value !== null && providerStatusFilters.some((candidate) => candidate === value);
}

export const invalidProviderURLDisplay = "Provider URL을 안전하게 표시할 수 없습니다.";

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
  const sloByProvider = new Map(slos.map((slo) => [slo.provider, slo]));
  const evaluationByProvider = new Map(evaluations.map((evaluation) => [evaluation.provider, evaluation]));
  const routingByProvider = new Map(routing?.providers.map((health) => [health.provider, health]) ?? []);
  const degradedProviders = new Set(routing?.degraded.map((health) => health.provider) ?? []);
  const occupiedIdentities = new Set(
    providers.filter((provider) => providerNameSafe(provider.name)).map((provider) => provider.name),
  );
  const occupiedDisplayNames = new Set(occupiedIdentities);
  let redactedDisplaySequence = 0;

  return providers.map((provider) => {
    const nameRedacted = !providerNameSafe(provider.name);
    const identity = nameRedacted ? redactedProviderIdentity(provider, occupiedIdentities) : provider.name;
    let displayName = provider.name;
    if (nameRedacted) {
      do {
        redactedDisplaySequence += 1;
        displayName = `Provider 이름 비공개 ${redactedDisplaySequence}`;
      } while (occupiedDisplayNames.has(displayName));
      occupiedDisplayNames.add(displayName);
    }
    const evaluation = nameRedacted ? undefined : evaluationByProvider.get(provider.name);
    const routingHealth = nameRedacted ? undefined : routingByProvider.get(provider.name);
    let health: ProviderHealthState = provider.enabled && healthPending ? "checking" : "unknown";
    if (provider.enabled) {
      if (healthPending) health = "checking";
      else if (routingHealth) health = degradedProviders.has(provider.name) ? "degraded" : "healthy";
      else if (evaluation?.enabled && evaluation.requests > 0) {
        health = evaluation.breached ? "degraded" : "healthy";
      }
    }
    return {
      displayName,
      provider: nameRedacted ? { ...provider, name: displayName } : provider,
      health,
      identity,
      nameRedacted,
      routing: routingHealth,
      slo: nameRedacted ? undefined : sloByProvider.get(provider.name),
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
