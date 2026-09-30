import type { Provider, ProviderSLO, ProviderSLOEvaluation, RoutingHealth } from "@/shared/api/schemas";
import { healthStatusLabels } from "@/config/ui-labels";
import { isSafeLegacyProviderName, providerDisplayLabels } from "@/shared/api/provider-ref";
import {
  containsConfiguredCredential,
  containsPotentialSecret,
  defaultCredentialPrefixes,
  isSensitiveCredentialKey,
} from "@/shared/security/secrets";

export const providerStatusFilters = [
  "all",
  "enabled",
  "disabled",
  "healthy",
  "degraded",
  "unknown",
] as const;

export type ProviderStatusFilter = (typeof providerStatusFilters)[number];
export const providerStatusLabels: Record<ProviderStatusFilter, string> = {
  all: "전체 상태",
  enabled: "활성",
  disabled: "비활성",
  healthy: healthStatusLabels.healthy,
  degraded: healthStatusLabels.degraded,
  unknown: healthStatusLabels.unknown,
};
export type ProviderHealthState = "checking" | "healthy" | "degraded" | "unknown";

export function providerPageNumber(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

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

function providerURLComponentHasSecret(value: string, credentialPrefixes: readonly string[]): boolean {
  let candidate = value;
  // The shared detector already bounds size and decoding. Also inspect decoded
  // path segments: /token=value (including an encoded slash) is a credential
  // assignment even though a slash is not an assignment separator in search text.
  for (let pass = 0; pass <= 8; pass += 1) {
    if (
      containsPotentialSecret(candidate, credentialPrefixes) ||
      candidate.split("/").some((part) => containsPotentialSecret(part, credentialPrefixes))
    ) {
      return true;
    }
    if (!/%[\da-f]{2}/i.test(candidate)) return false;
    if (pass === 8) return true;
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      return true;
    }
  }
  return true;
}

export function displayProviderBaseURL(
  value: string,
  credentialPrefixes: readonly string[] = defaultCredentialPrefixes,
): string {
  // WHATWG URL lowercases ASCII hosts and converts Unicode hosts to punycode.
  // Inspect the original host first, while case-sensitive configured prefixes
  // still exist. Userinfo is deliberately excluded: it is removed below without
  // discarding the otherwise safe URL context. The shared component check also
  // bounds and decodes percent-encoded prefixes before inspecting them.
  const authority = value.trim().match(/^https?:\/*([^/?#]*)/iu)?.[1];
  if (authority === undefined) return invalidProviderURLDisplay;
  const originalHost = authority.slice(authority.lastIndexOf("@") + 1);
  if (providerURLComponentHasSecret(originalHost, credentialPrefixes)) return invalidProviderURLDisplay;
  const url = parseProviderURL(value);
  if (!url) return invalidProviderURLDisplay;
  url.username = "";
  url.password = "";
  url.hash = "";
  if (
    providerURLComponentHasSecret(url.origin, credentialPrefixes) ||
    providerURLComponentHasSecret(url.pathname, credentialPrefixes)
  ) {
    return invalidProviderURLDisplay;
  }
  const publicQuery = new URLSearchParams();
  for (const pair of url.search.slice(1).split("&")) {
    const entry = new URLSearchParams(pair).entries().next().value;
    if (!entry) continue;
    const [key, queryValue] = entry;
    const separator = pair.indexOf("=");
    const rawKey = separator < 0 ? pair : pair.slice(0, separator);
    const rawValue = separator < 0 ? "" : pair.slice(separator + 1);
    // A key itself can contain a token; do not retain that name in the display.
    // Inspect raw fields too: form decoding changes a literal '+' to a space.
    if (
      providerURLComponentHasSecret(rawKey, credentialPrefixes) ||
      providerURLComponentHasSecret(key, credentialPrefixes)
    )
      continue;
    const privateValue =
      isSensitiveCredentialKey(key) ||
      containsPotentialSecret(`${key}=hidden`, credentialPrefixes) ||
      providerURLComponentHasSecret(rawValue, credentialPrefixes) ||
      providerURLComponentHasSecret(queryValue, credentialPrefixes);
    publicQuery.append(key, privateValue ? "***" : queryValue);
  }
  url.search = publicQuery.toString();
  // A configured prefix can itself contain query delimiters. Never reassemble
  // credential fragments that could not be attributed to one parsed field.
  if (containsConfiguredCredential(url.search, credentialPrefixes)) return invalidProviderURLDisplay;
  return url.toString();
}

export function providerSearchContainsSensitiveValue(
  value: string,
  credentialPrefixes: readonly string[] = defaultCredentialPrefixes,
): boolean {
  return containsPotentialSecret(value, credentialPrefixes);
}

export function displayProviderText(
  value: string,
  credentialPrefixes: readonly string[] = defaultCredentialPrefixes,
): string {
  return containsPotentialSecret(value, credentialPrefixes) ? "민감한 값은 표시하지 않습니다." : value;
}

export function isSafeProviderCatalogName(
  value: string,
  credentialPrefixes: readonly string[] = defaultCredentialPrefixes,
): boolean {
  return isSafeLegacyProviderName(value) && !containsPotentialSecret(value, credentialPrefixes);
}

export function buildProviderRows(
  providers: readonly Provider[],
  slos: readonly ProviderSLO[] = [],
  evaluations: readonly ProviderSLOEvaluation[] = [],
  routing?: RoutingHealth,
  healthPending = false,
  credentialPrefixes: readonly string[] = defaultCredentialPrefixes,
): ProviderCatalogRow[] {
  const sloByProvider = new Map(slos.map((item) => [item.provider_ref, item]));
  const evaluationByProvider = new Map(evaluations.map((item) => [item.provider_ref, item]));
  const routingByProvider = new Map(routing?.providers.map((item) => [item.provider_ref, item]) ?? []);
  const degradedProviders = new Set(routing?.degraded.map((item) => item.provider_ref) ?? []);
  const displayLabels = providerDisplayLabels(
    providers.map((provider) => ({
      name: isSafeProviderCatalogName(provider.name, credentialPrefixes)
        ? provider.name
        : "[provider-name-omitted]",
      providerRef: provider.provider_ref,
    })),
  );

  return providers.map((provider) => {
    const nameRedacted = !isSafeProviderCatalogName(provider.name, credentialPrefixes);
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
  credentialPrefixes: readonly string[] = defaultCredentialPrefixes,
): ProviderCatalogRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    const matchesQuery =
      normalizedQuery === "" ||
      [
        row.displayName,
        displayProviderBaseURL(row.provider.base_url, credentialPrefixes),
        displayProviderText(row.provider.model_patterns, credentialPrefixes),
        displayProviderText(row.provider.failover_group, credentialPrefixes),
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    if (!matchesQuery) return false;
    if (status === "all") return true;
    if (status === "enabled") return row.provider.enabled;
    if (status === "disabled") return !row.provider.enabled;
    return row.health === status;
  });
}
