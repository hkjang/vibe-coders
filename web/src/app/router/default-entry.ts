import { featurePath, resolveFeature, type MigrationFeature } from "@/config/migration-registry";
import type { AuthUser } from "@/shared/api/schemas";
import { safeReturnTo } from "@/shared/utils/safe-return-to";

interface DefaultEntryContext {
  features: readonly MigrationFeature[];
  user: AuthUser | undefined;
  backendVersion: string;
  legacyFallback: boolean;
}

export function resolveDefaultEntry(
  configuredEntry: string,
  { features, user, backendVersion, legacyFallback }: DefaultEntryContext,
): string {
  const candidate = safeReturnTo(configuredEntry, "");
  const candidatePath = candidate.split(/[?#]/u, 1)[0] ?? "";
  const configuredFeature = features.find((feature) => featurePath(feature) === candidatePath);
  if (
    configuredFeature &&
    resolveFeature(configuredFeature, user, backendVersion, { legacyFallback }).permitted
  ) {
    return candidate;
  }

  const available = features.filter(
    (feature) => resolveFeature(feature, user, backendVersion, { legacyFallback }).permitted,
  );
  const fallback = available.find((feature) => feature.featureId === "overview") ?? available[0];
  return fallback ? featurePath(fallback) : "/overview";
}
