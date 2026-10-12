import type { ResourceKind } from "@/shared/api/resource-search";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { isProviderRef } from "@/shared/api/provider-ref";

export const resourceSearchTargets = {
  provider: {
    featureId: "gateway.providers",
    title: "AI 공급자",
    path: "/gateway/providers",
    parameter: "provider",
  },
  workflow: {
    featureId: "agents.workflows",
    title: "워크플로",
    path: "/agents/workflows",
    parameter: "workflow",
  },
  app: { featureId: "agents.apps", title: "AI 업무 앱", path: "/agents/apps", parameter: "app" },
  skill: { featureId: "agents.skills", title: "스킬", path: "/agents/skills", parameter: "skill" },
} satisfies Record<ResourceKind, { featureId: string; title: string; path: string; parameter: string }>;

export function resourceSearchPath(
  kind: ResourceKind,
  id: string,
  prefixes: readonly string[],
): string | undefined {
  if (!id || [...id].length > 512 || containsPotentialSecret(id, prefixes)) return undefined;
  if (kind === "provider" && !isProviderRef(id)) return undefined;
  const target = resourceSearchTargets[kind];
  const params = new URLSearchParams({ [target.parameter]: id });
  // Skills have more than one tab; the detail belongs to the registry tab.
  if (kind === "skill") params.set("tab", "catalog");
  return `${target.path}?${params}`;
}
