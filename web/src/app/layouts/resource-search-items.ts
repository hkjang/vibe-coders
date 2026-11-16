import type { ResourceKind } from "@/shared/api/resource-search";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { isProviderRef } from "@/shared/api/provider-ref";

export const resourceSearchTargets = {
  api_key: {
    featureId: "access.users",
    title: "API 키",
    path: "/access/users",
    parameter: "api_key_id",
  },
  setting: {
    featureId: "system.settings",
    title: "시스템 설정",
    path: "/system/settings",
    parameter: "setting",
  },
  prompt_asset: {
    featureId: "prompts.library",
    title: "프롬프트 자산",
    path: "/prompts/library",
    parameter: "asset",
  },
  prompt_experiment: {
    featureId: "prompts.lab",
    title: "프롬프트 실험",
    path: "/prompts/lab",
    parameter: "exp",
  },
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
  mcp_tool: { featureId: "mcp.overview", title: "MCP 도구", path: "/mcp", parameter: "tool" },
  policy: {
    featureId: "governance.policies",
    title: "정책",
    path: "/governance/policies/detail",
    parameter: "policy",
  },
  team: {
    featureId: "access.users",
    title: "등록 팀",
    path: "/access/users",
    parameter: "registered_team",
  },
  account: {
    featureId: "access.users",
    title: "로그인 계정",
    path: "/access/users/accounts",
    parameter: "account_id",
  },
} satisfies Record<ResourceKind, { featureId: string; title: string; path: string; parameter: string }>;

export function resourceSearchReadScope(kind: ResourceKind): string {
  if (kind === "policy") return "security:read";
  return kind === "mcp_upstream" || kind === "mcp_tool" ? "observability:read" : "admin:read";
}

export function resourceSearchPath(
  kind: ResourceKind,
  id: string,
  prefixes: readonly string[],
  serverLabel?: string,
): string | undefined {
  if (!id || [...id].length > 512 || containsPotentialSecret(id, prefixes)) return undefined;
  if (
    (kind === "prompt_asset" || kind === "prompt_experiment") &&
    (id.length > 512 || id.trim() !== id || /\p{C}/u.test(id))
  )
    return undefined;
  if (kind === "setting" && !/^[a-z][a-z0-9._-]{0,255}$/u.test(id)) return undefined;
  if (kind === "api_key" && !/^[A-Za-z0-9._:-]{1,512}$/u.test(id)) return undefined;
  if (kind === "provider" && !isProviderRef(id)) return undefined;
  if (kind === "mcp_upstream" && !/^[a-z0-9_][a-z0-9_-]*$/u.test(id)) return undefined;
  if ((kind === "team" || kind === "account") && /\p{C}/u.test(id)) return undefined;
  const target = resourceSearchTargets[kind];
  const params = new URLSearchParams({ [target.parameter]: id });
  if (kind === "mcp_tool") {
    if (
      !serverLabel ||
      [...serverLabel].length > 512 ||
      [...id].length > 256 ||
      /\p{C}/u.test(id + serverLabel) ||
      id.trim() !== id ||
      serverLabel.trim() !== serverLabel ||
      containsPotentialSecret(serverLabel, prefixes)
    )
      return undefined;
    params.set("server", serverLabel);
    params.set("tab", "tools");
    params.set("mcp_only", "1");
  }
  if (kind === "setting") params.set("tab", id.startsWith("ui.app.") ? "console" : "runtime");
  if (kind === "prompt_asset") params.set("tab", "assets");
  // Skills have more than one tab; the detail belongs to the registry tab.
  if (kind === "skill") params.set("tab", "catalog");
  if (kind === "mcp_upstream") params.set("tab", "upstreams");
  if (kind === "policy") params.set("tab", "safety");
  if (kind === "team") params.set("tab", "teams");
  if (kind === "api_key") params.set("tab", "keys");
  return `${target.path}?${params}`;
}
