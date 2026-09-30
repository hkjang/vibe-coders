import type { ProviderImpact, ProviderImpactSection } from "@/shared/api/domains/provider-impact";

export function impactSection(overrides: Partial<ProviderImpactSection> = {}): ProviderImpactSection {
  return {
    status: "complete",
    scope: "direct_provider_references",
    reason: "",
    count_kind: "exact",
    scanned_count: 0,
    matched_count: 0,
    truncated: false,
    items: [],
    ...overrides,
  };
}

export function providerImpactFixture(
  providerRef: string,
  overrides: Partial<ProviderImpact> = {},
): ProviderImpact {
  return {
    provider_ref: providerRef,
    provider_display: "공개 공급자",
    generated_at: "2026-09-30T01:00:00Z",
    consistency: "best_effort",
    is_default: false,
    bootstrap_on_restart: false,
    read_only: true,
    upstream_calls: false,
    concurrent_change_guard: false,
    not_assessed: [
      "pattern_overlap",
      "full_model_catalog",
      "model_usage",
      "runtime_call_success",
      "ip_and_model_authorization",
      "concurrent_change_guard",
    ],
    routing_rules: impactSection(),
    agent_routes: impactSection(),
    failover_peers: impactSection({ scope: "configured_failover_group" }),
    api_keys: impactSection({ scope: "eligible_provider_access_configuration" }),
    teams: impactSection({ scope: "teams_of_eligible_key_configuration" }),
    ...overrides,
  };
}
