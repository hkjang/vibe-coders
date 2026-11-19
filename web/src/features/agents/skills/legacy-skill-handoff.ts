import { isLegacyAdminHref, legacyRoutes } from "@/config/legacy-route-map";
import { safeSkillNameForURL, validSkillReference } from "./skill-identity";
import { containsPotentialSecret } from "@/shared/security/secrets";
export const validSkillHandoffName = safeSkillNameForURL;

export function skillLegacyHandoff(
  base: string | undefined,
  id: string | undefined,
  supported: boolean,
  prefixes: readonly string[],
  reference?: string,
  referenceSupported = false,
): { href?: `/admin${string}`; sameSkill: boolean } {
  if (!isLegacyAdminHref(base) || containsPotentialSecret(base, prefixes)) return { sameSkill: false };
  const fallback = { href: base, sameSkill: false };
  if (base === legacyRoutes.skills && referenceSupported && validSkillReference(reference)) {
    const href = `${base}?${new URLSearchParams({ skill_ref: reference })}`;
    return isLegacyAdminHref(href) ? { href, sameSkill: true } : fallback;
  }
  if (base !== legacyRoutes.skills || !supported || id === undefined || !validSkillHandoffName(id, prefixes))
    return fallback;
  const href = `${base}?${new URLSearchParams({ skill_name: id })}`;
  return href.length <= 16384 && isLegacyAdminHref(href) ? { href, sameSkill: true } : fallback;
}
