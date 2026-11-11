import { useMemo } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { resolveFeature } from "@/config/migration-registry";

/** Re-evaluate every shortcut against the same live authority as the main menu. */
export function useNavigationItems() {
  const { features, user, backendVersion, legacyFallback } = useAuth();
  return useMemo(
    () =>
      features
        .map((feature) => ({
          feature,
          effective: resolveFeature(feature, user, backendVersion, { legacyFallback }),
        }))
        .filter(({ effective }) => effective.permitted && effective.status !== "hidden"),
    [features, user, backendVersion, legacyFallback],
  );
}

export type NavigationItem = ReturnType<typeof useNavigationItems>[number];

export function orderedNavigationItems(
  ids: readonly string[],
  items: readonly NavigationItem[],
): NavigationItem[] {
  return [...new Set(ids)].flatMap((id) => {
    const item = items.find(({ feature }) => feature.featureId === id);
    return item ? [item] : [];
  });
}
