import { describe, expect, it, vi } from "vitest";

import { ApiClient } from "@/shared/api/client";
import {
  providerImpactSchema,
  type ProviderImpact,
  type ProviderImpactSection,
} from "@/shared/api/domains/provider-impact";
import { endpoints } from "@/shared/api/endpoints";

function section(scope: ProviderImpactSection["scope"]): ProviderImpactSection {
  return {
    status: "complete",
    scope,
    reason: "",
    count_kind: "exact",
    scanned_count: 0,
    matched_count: 0,
    truncated: false,
    items: [],
  };
}
function fixture(): ProviderImpact {
  return {
    provider_ref: `prv_${"a".repeat(43)}`,
    provider_display: "public-provider",
    generated_at: "2026-09-30T00:00:00.123456789Z",
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
    routing_rules: section("direct_provider_references"),
    agent_routes: section("direct_provider_references"),
    failover_peers: section("configured_failover_group"),
    api_keys: section("eligible_provider_access_configuration"),
    teams: section("teams_of_eligible_key_configuration"),
  };
}

describe("공급자 참조 영향 API 계약", () => {
  it("현재 설정의 정확한 0건과 확인한 하한 수치를 구분한다", () => {
    const payload = fixture();
    expect(providerImpactSchema.parse(payload).routing_rules.matched_count).toBe(0);
    payload.api_keys = {
      ...payload.api_keys,
      status: "partial",
      reason: "bounded_or_unassessable_configuration",
      count_kind: "lower_bound",
      scanned_count: 1024,
      matched_count: 7,
      truncated: true,
    };
    expect(providerImpactSchema.parse(payload).api_keys).toMatchObject({
      status: "partial",
      count_kind: "lower_bound",
      matched_count: 7,
    });
  });

  it.each(["denied", "unavailable"] as const)("%s 상태는 null이고 참조 목록을 가지지 않는다", (status) => {
    const payload = fixture();
    payload.routing_rules = {
      ...payload.routing_rules,
      status,
      reason: status === "denied" ? "routing_read_required" : "configuration_read_failed",
      count_kind: "unknown",
      scanned_count: null,
      matched_count: null,
    };
    expect(providerImpactSchema.parse(payload).routing_rules.matched_count).toBeNull();
    expect(
      providerImpactSchema.safeParse({
        ...payload,
        routing_rules: {
          ...payload.routing_rules,
          matched_count: 0,
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    { scanned_count: -1 },
    { matched_count: 0.5 },
    { scanned_count: 1025 },
    { matched_count: 1, scanned_count: 0 },
    { count_kind: "lower_bound" },
    { status: "partial", truncated: true },
    { truncated: true },
    { items: [{ reference: "raw-provider-name", label: "public", enabled: true }] },
    { items: [{ reference: `impact_${"x".repeat(43)}`, label: "x".repeat(1025), enabled: true }] },
  ])("잘못된 집계를 정상 데이터로 표시하지 않는다: %j", (invalid) => {
    const payload = fixture();
    expect(
      providerImpactSchema.safeParse({
        ...payload,
        routing_rules: {
          ...payload.routing_rules,
          ...invalid,
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    { provider_ref: "raw-name" },
    { generated_at: "not-a-date" },
    { read_only: false },
    { upstream_calls: true },
    { concurrent_change_guard: true },
  ])("현재 조회 계약이 보장하지 않는 응답을 거절한다: %j", (invalid) => {
    expect(providerImpactSchema.safeParse({ ...fixture(), ...invalid }).success).toBe(false);
  });

  it("등록된 API만 사용하고 원본 공급자 이름 없이 참조로 조회한다", async () => {
    const payload = fixture();
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = new ApiClient({ fetch: fetchMock });
    await expect(
      client.request(endpoints.admin.providers.impact, {
        query: { provider_ref: payload.provider_ref },
        routeId: "gateway.providers",
      }),
    ).resolves.toEqual(payload);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/admin/provider-impact?provider_ref=${payload.provider_ref}`);
  });

  it("참조가 아닌 식별자는 네트워크 요청 전에 거절한다", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new ApiClient({ fetch: fetchMock });
    await expect(
      client.request(endpoints.admin.providers.impact, {
        query: { provider_ref: "sk-public-synthetic" },
      }),
    ).rejects.toMatchObject({ kind: "contract" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
