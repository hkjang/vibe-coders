import { featureByPath, type MigrationFeature } from "@/config/migration-registry";
import { accessFeatureModules } from "@/features/access/routes";
import { agentsFeatureModules } from "@/features/agents/routes";
import { dataFeatureModules } from "@/features/data/routes";
import type { FeatureModule } from "@/features/feature-module";
import { finopsFeatureModules } from "@/features/finops/routes";
import { gatewayFeatureModules } from "@/features/gateway/routes";
import { governanceFeatureModules } from "@/features/governance/routes";
import { mcpFeatureModules } from "@/features/mcp/routes";
import { observabilityFeatureModules } from "@/features/observability/routes";
import { overviewFeatureModules } from "@/features/overview/routes";
import { promptsFeatureModules } from "@/features/prompts/routes";
import { routingFeatureModules } from "@/features/routing/routes";
import { securityFeatureModules } from "@/features/security/routes";
import { systemFeatureModules } from "@/features/system/routes";
import { text2sqlFeatureModules } from "@/features/text2sql/routes";

const allFeatureModules: readonly FeatureModule[] = [
  ...overviewFeatureModules,
  ...accessFeatureModules,
  ...agentsFeatureModules,
  ...dataFeatureModules,
  ...finopsFeatureModules,
  ...gatewayFeatureModules,
  ...governanceFeatureModules,
  ...mcpFeatureModules,
  ...observabilityFeatureModules,
  ...promptsFeatureModules,
  ...routingFeatureModules,
  ...securityFeatureModules,
  ...systemFeatureModules,
  ...text2sqlFeatureModules,
];

const modulesById: ReadonlyMap<string, FeatureModule> = new Map(
  allFeatureModules.map((module) => [module.featureId, module]),
);

if (modulesById.size !== allFeatureModules.length) {
  const seen = new Set<string>();
  const duplicate = allFeatureModules.find((module) => {
    if (seen.has(module.featureId)) return true;
    seen.add(module.featureId);
    return false;
  });
  throw new Error(`feature ${duplicate?.featureId ?? "?"} is registered by more than one domain`);
}

export function featureModule(featureId: string): FeatureModule | undefined {
  return modulesById.get(featureId);
}

/** Feature IDs whose React screen is present in this build. */
export const implementedFeatureIds: ReadonlySet<string> = new Set(modulesById.keys());

/** Query keys the screen owning `pathname` (a router path without `/app`) accepts. */
export function featureQueryKeys(
  pathname: string,
  registry: readonly MigrationFeature[] | undefined = undefined,
): ReadonlySet<string> | undefined {
  const feature = registry ? featureByPath(pathname, registry) : featureByPath(pathname);
  const module = feature ? modulesById.get(feature.featureId) : undefined;
  return module?.queryKeys ? new Set(module.queryKeys) : undefined;
}
