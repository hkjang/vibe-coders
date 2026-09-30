import type { ProviderImpactResponse, ProviderImpactSection } from "../../../src/shared/api/generated";

function section(scope: ProviderImpactSection["scope"], count = 0): ProviderImpactSection {
  return {
    status: "complete",
    scope,
    reason: "",
    count_kind: "exact",
    scanned_count: count,
    matched_count: count,
    truncated: false,
    items: [],
  };
}

/** Public synthetic current-configuration data; no runtime impact guarantee. */
export function impactFixture(providerRef: string, partial = false): ProviderImpactResponse {
  const routing = section("direct_provider_references", 13);
  routing.items = Array.from({ length: 13 }, (_, index) => ({
    reference: `impact_${String(index).padStart(43, "r")}`,
    label: `공개 경로 ${index + 1}`,
    enabled: index % 2 === 0,
    model: `public-model-${index + 1}`,
    relation: "direct_binding" as const,
  }));
  return {
    provider_ref: providerRef,
    provider_display: "공개 공급자",
    generated_at: new Date().toISOString(),
    consistency: "best_effort",
    is_default: true,
    bootstrap_on_restart: true,
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
    routing_rules: partial
      ? {
          ...routing,
          status: "partial",
          reason: "bounded_or_unassessable_configuration",
          count_kind: "lower_bound",
          truncated: true,
        }
      : routing,
    agent_routes: partial
      ? {
          ...section("direct_provider_references"),
          status: "unavailable",
          reason: "configuration_read_failed",
          count_kind: "unknown",
          scanned_count: null,
          matched_count: null,
        }
      : section("direct_provider_references"),
    failover_peers: section("configured_failover_group"),
    api_keys: partial
      ? {
          ...section("eligible_provider_access_configuration"),
          status: "unavailable",
          reason: "configuration_read_failed",
          count_kind: "unknown",
          scanned_count: null,
          matched_count: null,
        }
      : section("eligible_provider_access_configuration", 2),
    teams: partial
      ? {
          ...section("teams_of_eligible_key_configuration"),
          status: "unavailable",
          reason: "key_configuration_unavailable",
          count_kind: "unknown",
          scanned_count: null,
          matched_count: null,
        }
      : section("teams_of_eligible_key_configuration", 1),
  };
}
