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
  mcp_upstream: { featureId: "mcp.overview", title: "MCP 서버", path: "/mcp", parameter: "upstream" },
  policy: {
    featureId: "governance.policies",
    title: "정책",
    path: "/governance/policies/detail",
    parameter: "policy",
  },
} satisfies Record<ResourceKind, { featureId: string; title: string; path: string; parameter: string }>;

export function resourceSearchReadScope(kind: ResourceKind): string {
  if (kind === "policy") return "security:read";
  return kind === "mcp_upstream" ? "observability:read" : "admin:read";
}

export function resourceSearchPath(
  kind: ResourceKind,
  id: string,
  prefixes: readonly string[],
): string | undefined {
  if (!id || [...id].length > 512 || containsPotentialSecret(id, prefixes)) return undefined;
  if (kind === "provider" && !isProviderRef(id)) return undefined;
  if (kind === "mcp_upstream" && !/^[a-z0-9_][a-z0-9_-]*$/u.test(id)) return undefined;
  const target = resourceSearchTargets[kind];
  const params = new URLSearchParams({ [target.parameter]: id });
  // Skills have more than one tab; the detail belongs to the registry tab.
  if (kind === "skill") params.set("tab", "catalog");
  if (kind === "mcp_upstream") params.set("tab", "upstreams");
  if (kind === "policy") params.set("tab", "safety");
  return `${target.path}?${params}`;
}
