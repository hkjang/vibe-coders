import { isLegacyAdminHref, legacyRoutes } from "@/config/legacy-route-map";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { validWorkAppDetailId } from "./work-app-page-model";

export function workAppLegacyHandoff(
  base: string | undefined,
  id: string | undefined,
  supported: boolean,
  prefixes: readonly string[],
): { href?: `/admin${string}`; sameApp: boolean } {
  if (!isLegacyAdminHref(base) || containsPotentialSecret(base, prefixes)) return { sameApp: false };
  const fallback = { href: base, sameApp: false };
  if (base !== legacyRoutes.apps || !supported || id === undefined || !validWorkAppDetailId(id, prefixes))
    return fallback;
  const href = `${base}?${new URLSearchParams({ app_id: id })}`;
  return href.length <= 16384 && isLegacyAdminHref(href) ? { href, sameApp: true } : fallback;
}
