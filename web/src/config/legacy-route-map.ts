import type { FeatureId } from "./migration-registry";

/** Canonical Legacy hash routes. Feature ownership remains in the migration registry. */
export const legacyRoutes = {
  dashboard: "/admin#/dashboard",
  me: "/admin#/me",
  team: "/admin#/team",
  routingHealth: "/admin#/routing/health",
  settings: "/admin#/settings",
  modelContracts: "/admin#/model-contracts",
  chatTest: "/admin#/chat-test",
  routing: "/admin#/routing",
  requests: "/admin#/requests",
  llm: "/admin#/llm",
  sessions: "/admin#/sessions",
  xview: "/admin#/xview",
  journeyProbe: "/admin#/journey-probe",
  promptLab: "/admin#/prompt-lab",
  prompts: "/admin#/prompts",
  users: "/admin#/users",
  safety: "/admin#/safety",
  remediation: "/admin#/remediation",
  scorecard: "/admin#/scorecard",
  sbom: "/admin#/sbom",
  mcp: "/admin#/mcp",
  gatewayMcp: "/admin#/gateway-mcp",
  agents: "/admin#/agents",
  workflows: "/admin#/workflows",
  apps: "/admin#/apps",
  skills: "/admin#/skills",
  text2sql: "/admin#/text2sql",
  warehouse: "/admin#/dwdashboard",
  dataProducts: "/admin#/data-products",
  billing: "/admin#/billing",
  security: "/admin#/security",
  redteam: "/admin#/redteam",
  sandbox: "/admin#/sandbox",
  operations: "/admin#/ops-home",
  ips: "/admin#/ips",
} as const;

interface LegacyFeatureDestination {
  featureId: FeatureId;
  href: `/admin${string}`;
}

// These are the manual destinations emitted by admin_remediation.go.
// Keep this explicit: settings/llm routes can have multiple owners, so an
// arbitrary string or prefix cannot safely select a target feature.
const remediationTargets = new Map<string, LegacyFeatureDestination>([
  ["#/billing", { featureId: "finops.overview", href: legacyRoutes.billing }],
  ["#/safety", { featureId: "governance.policies", href: legacyRoutes.safety }],
]);

export function legacyRemediationTarget(link: string | undefined): LegacyFeatureDestination | undefined {
  return link ? remediationTargets.get(link) : undefined;
}

/** The caller validates the IP identity and access policy before constructing its destination. */
export function legacyIpHref(ip?: string): `/admin${string}` {
  return ip ? `${legacyRoutes.ips}/${encodeURIComponent(ip)}` : legacyRoutes.ips;
}
