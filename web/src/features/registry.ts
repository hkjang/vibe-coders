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
import { promptsFeatureModules } from "@/features/prompts/routes";
import { routingFeatureModules } from "@/features/routing/routes";
import { securityFeatureModules } from "@/features/security/routes";
import { systemFeatureModules } from "@/features/system/routes";
import { text2sqlFeatureModules } from "@/features/text2sql/routes";

// Screens that shipped before the domain registries existed keep their original
// locations; they are registered here so the router has a single source.
const foundationFeatureModules: readonly FeatureModule[] = [
  {
    featureId: "overview",
    load: () => import("@/features/overview/OverviewPage").then((module) => module.OverviewPage),
    queryKeys: ["range", "tab"],
  },
  {
    featureId: "gateway.health",
    load: () =>
      import("@/features/gateway/health/GatewayHealthPage").then((module) => module.GatewayHealthPage),
    queryKeys: ["range"],
  },
  {
    featureId: "gateway.providers",
    load: () => import("@/features/gateway/providers/ProviderPage").then((module) => module.ProviderPage),
    queryKeys: ["page", "provider", "q", "range", "status"],
  },
  {
    featureId: "gateway.models",
    load: () => import("@/features/gateway/models/ModelPage").then((module) => module.ModelPage),
    queryKeys: ["model", "model_provider", "page", "provider", "q", "range", "source", "status"],
  },
  {
    featureId: "observability.requests",
    load: () => import("@/features/observability/requests/RequestPage").then((module) => module.RequestPage),
    queryKeys: [
      "api_key_id",
      "cursor",
      "from",
      "ip",
      "language",
      "limit",
      "model",
      "provider_ref",
      "request_id",
      "session_id",
      "status",
      "to",
      "trace_id",
      "tz",
    ],
  },
  {
    featureId: "observability.traces",
    load: () => import("@/features/observability/traces/TracePage").then((module) => module.TracePage),
    queryKeys: [
      "cursor",
      "from",
      "limit",
      "model",
      "selected_ref",
      "selected_request",
      "status",
      "to",
      "trace_id",
      "tz",
    ],
  },
  {
    featureId: "system.health",
    load: () => import("@/features/system/health/SystemHealthPage").then((module) => module.SystemHealthPage),
    queryKeys: ["range"],
  },
];

const allFeatureModules: readonly FeatureModule[] = [
  ...foundationFeatureModules,
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
