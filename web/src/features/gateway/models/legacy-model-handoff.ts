import { isLegacyAdminHref, legacyRoutes } from "@/config/legacy-route-map";
import { isProviderRef } from "@/shared/api/provider-ref";
import type { AdminModel } from "@/shared/api/schemas";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { isModelSource } from "./model-catalog";

export function modelLegacyHandoff(
  base: string | undefined,
  model: Pick<AdminModel, "id" | "provider_ref" | "source"> | undefined,
  supported: boolean,
  prefixes: readonly string[],
): { href?: `/admin${string}`; sameModel: boolean } {
  if (!isLegacyAdminHref(base) || containsPotentialSecret(base, prefixes)) return { sameModel: false };
  const fallback = { href: base, sameModel: false };
  if (base !== legacyRoutes.modelContracts || !supported || !model) return fallback;
  if (
    !model.id ||
    model.id.length > 4096 ||
    model.id.trim() !== model.id ||
    Array.from(model.id).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    containsPotentialSecret(model.id, prefixes) ||
    !isProviderRef(model.provider_ref) ||
    !isModelSource(model.source)
  )
    return fallback;
  // URLSearchParams replaces unpaired UTF-16 surrogates; never change a resource ID.
  try {
    encodeURIComponent(model.id);
  } catch {
    return fallback;
  }
  const params = new URLSearchParams({
    model: model.id,
    provider_ref: model.provider_ref,
    source: model.source,
  });
  const href = `${base}?${params}`;
  return href.length <= 8192 && isLegacyAdminHref(href) ? { href, sameModel: true } : fallback;
}
