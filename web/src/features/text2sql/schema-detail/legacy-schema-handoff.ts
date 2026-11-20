import { isLegacyAdminHref, legacyRoutes } from "@/config/legacy-route-map";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { validSchemaDetailName } from "./schema-detail-model";

export function schemaLegacyHandoff(
  base: string | undefined,
  name: string | undefined,
  supported: boolean,
  prefixes: readonly string[],
): { href?: `/admin${string}`; sameSchema: boolean } {
  if (!isLegacyAdminHref(base) || containsPotentialSecret(base, prefixes)) return { sameSchema: false };
  const fallback = { href: base, sameSchema: false };
  if (
    base !== legacyRoutes.text2sql ||
    !supported ||
    name === undefined ||
    !validSchemaDetailName(name, prefixes)
  )
    return fallback;
  const href = `${base}?${new URLSearchParams({ schema_name: name })}`;
  return href.length <= 8192 && isLegacyAdminHref(href) ? { href, sameSchema: true } : fallback;
}
