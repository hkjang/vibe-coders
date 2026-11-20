import { isLegacyAdminHref, legacyRoutes } from "@/config/legacy-route-map";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { validRoutingRuleDetailId } from "./routing-rule-detail-model";

export function routingRuleLegacyHandoff(
  base: string | undefined,
  id: string | undefined,
  supported: boolean,
  prefixes: readonly string[],
): { href?: `/admin${string}`; sameRule: boolean } {
  if (!isLegacyAdminHref(base) || containsPotentialSecret(base, prefixes)) return { sameRule: false };
  const fallback = { href: base, sameRule: false };
  if (
    base !== legacyRoutes.routing ||
    !supported ||
    id === undefined ||
    !validRoutingRuleDetailId(id, prefixes)
  )
    return fallback;
  const href = `${base}?${new URLSearchParams({ rule_id: id })}`;
  return href.length <= 8192 && isLegacyAdminHref(href) ? { href, sameRule: true } : fallback;
}
