import { isLegacyAdminHref, legacyRoutes } from "@/config/legacy-route-map";
import { containsPotentialSecret } from "@/shared/security/secrets";
export function validSkillHandoffName(name: string, prefixes: readonly string[]): boolean {
  return (
    name !== "" &&
    new TextEncoder().encode(name).length <= 4096 &&
    !/[\\\p{C}]/u.test(name) &&
    !containsPotentialSecret(name, prefixes)
  );
}

export function skillLegacyHandoff(
  base: string | undefined,
  id: string | undefined,
  supported: boolean,
  prefixes: readonly string[],
): { href?: `/admin${string}`; sameSkill: boolean } {
  if (!isLegacyAdminHref(base) || containsPotentialSecret(base, prefixes)) return { sameSkill: false };
  const fallback = { href: base, sameSkill: false };
  if (base !== legacyRoutes.skills || !supported || id === undefined || !validSkillHandoffName(id, prefixes))
    return fallback;
  const href = `${base}?${new URLSearchParams({ skill_name: id })}`;
  return href.length <= 16384 && isLegacyAdminHref(href) ? { href, sameSkill: true } : fallback;
}
