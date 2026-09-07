import { defineFeatureModules } from "@/features/feature-module";

// Screens owned by the mcp domain. Register each implemented feature here.
export const mcpFeatureModules = defineFeatureModules([
  {
    featureId: "mcp.overview",
    load: () => import("@/features/mcp/overview/McpPage").then((module) => module.McpPage),
    queryKeys: [
      "action",
      "configured",
      "errors",
      "mcp_only",
      "request_id",
      "risk_level",
      "server",
      "tab",
      "tool",
      "upstream",
    ],
  },
  {
    featureId: "mcp.gateway",
    load: () => import("@/features/mcp/gateway/GatewayMcpPage").then((module) => module.GatewayMcpPage),
  },
  {
    featureId: "agents.registry",
    load: () => import("@/features/mcp/agents/AgentRegistryPage").then((module) => module.AgentRegistryPage),
    queryKeys: ["api_key_id", "kind", "repo", "session_id", "tab", "window"],
  },
]);
