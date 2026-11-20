import { isLegacyAdminHref, legacyRoutes } from "@/config/legacy-route-map";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { validAPIKeyDetailId } from "./api-key-detail-model";
import { validAccountId } from "./account-detail-model";
import { validRegisteredTeamId } from "./registered-team-detail-model";

export type LegacyAccessResource = "key" | "account" | "team";

export function accessLegacyHandoff(
  base: string | undefined,
  resource: LegacyAccessResource,
  id: string | undefined,
  supported: boolean,
  prefixes: readonly string[],
): { href?: `/admin${string}`; sameResource: boolean } {
  if (!isLegacyAdminHref(base) || containsPotentialSecret(base, prefixes)) return { sameResource: false };
  const fallback = { href: base, sameResource: false };
  const validate = { key: validAPIKeyDetailId, account: validAccountId, team: validRegisteredTeamId }[
    resource
  ];
  if (base !== legacyRoutes.users || !supported || id === undefined || !validate(id, prefixes))
    return fallback;
  const href = `${base}?${new URLSearchParams({ resource, id })}`;
  return href.length <= 16384 && isLegacyAdminHref(href) ? { href, sameResource: true } : fallback;
}
