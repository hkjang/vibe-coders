import type { FeatureId } from "./migration-registry";

// Subscreens inherit permissions and fallback availability from their owner.
export const legacySubroutes = { "access.ips": "/admin#/ips" } as const;

interface LegacyFeatureDestination {
  featureId: FeatureId;
  href: `/admin${string}`;
}

// These are the manual destinations emitted by admin_remediation.go.
// Keep this explicit: settings/llm routes can have multiple owners, so an
// arbitrary string or prefix cannot safely select a target feature.
const remediationTargets = new Map<string, LegacyFeatureDestination>([
  ["#/billing", { featureId: "finops.overview", href: "/admin#/billing" }],
  ["#/safety", { featureId: "governance.policies", href: "/admin#/safety" }],
]);

export function legacyRemediationTarget(link: string | undefined): LegacyFeatureDestination | undefined {
  return link ? remediationTargets.get(link) : undefined;
}
