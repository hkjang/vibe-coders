import { isLegacyAdminHref, legacyRoutes } from "./legacy-route-map";
import { containsPotentialSecret } from "@/shared/security/secrets";

export function validPolicyHandoffId(id: string, prefixes: readonly string[]): boolean {
  if (!id || id.trim() !== id || [...id].length > 512 || /\p{Cc}/u.test(id)) return false;
  try {
    encodeURIComponent(id);
  } catch {
    return false;
  }
  return !containsPotentialSecret(id, prefixes);
}

export function policyLegacyHandoff(
  base: string | undefined,
  id: string,
  supported: boolean,
  prefixes: readonly string[],
): { href?: `/admin${string}`; samePolicy: boolean } {
  if (!isLegacyAdminHref(base) || containsPotentialSecret(base, prefixes)) return { samePolicy: false };
  const fallback = { href: base, samePolicy: false };
  if (base !== legacyRoutes.safety || !supported || !validPolicyHandoffId(id, prefixes)) return fallback;
  const href = `${base}?${new URLSearchParams({ policy_id: id })}`;
  return href.length <= 16384 && isLegacyAdminHref(href) ? { href, samePolicy: true } : fallback;
}
