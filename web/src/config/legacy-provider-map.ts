import { isProviderRef } from "@/shared/api/provider-ref";
import { legacyRoutes } from "./legacy-route-map";

/** Only the canonical settings screen understands this opaque resource selection. */
export function legacyProviderDetailHref(
  baseHref: string | undefined,
  providerRef: string | undefined,
): `/admin${string}` | undefined {
  if (baseHref !== legacyRoutes.settings || !isProviderRef(providerRef) || providerRef.length !== 47) {
    return undefined;
  }
  return `/admin#/settings?${new URLSearchParams({ provider_ref: providerRef })}`;
}
