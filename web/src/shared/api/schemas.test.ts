import { describe, expect, it } from "vitest";

import {
  adminModelsResponseSchema,
  migrationFeatureSchema,
  modelQualityResponseSchema,
  modelUsageTagsResponseSchema,
  pricingResponseSchema,
  providerHealthScoreSchema,
  providerListSchema,
  providerSLOResponseSchema,
  routingHealthSchema,
  uiBootstrapSchema,
} from "@/shared/api/schemas";

const providerRef = `prv_${"a".repeat(43)}`;

const validBootstrap = {
  backend_version: "v0.80.0",
  ui_version: "v0.80.0",
  api_version: "v1",
  ui: {
    enabled: true,
    default_entry: "/app/overview",
    legacy_fallback: true,
    feedback_enabled: false,
    telemetry_enabled: false,
  },
  authentication: {
    enabled: true,
    authenticated: true,
    mode: "session",
    keycloak_enabled: true,
    allow_local_login: true,
    sso_login_url: "/auth/keycloak/login",
  },
  user: null,
  roles: ["admin"],
  permissions: ["admin:read"],
  allowed_features: ["overview"],
  migration_registry: [],
  system_status: { status: "healthy" },
  legacy_route_map: { overview: "/admin#/dashboard" },
} as const;

describe("OpenAPI runtime schemas", () => {
  it("accepts a complete UI bootstrap response", () => {
    expect(uiBootstrapSchema.safeParse(validBootstrap).success).toBe(true);
  });

  it("rejects missing top-level OpenAPI-required bootstrap fields", () => {
    expect(
      uiBootstrapSchema.safeParse({
        ui: validBootstrap.ui,
        authentication: validBootstrap.authentication,
        system_status: validBootstrap.system_status,
      }).success,
    ).toBe(false);
  });

  it("rejects missing nested OpenAPI-required bootstrap fields", () => {
    expect(
      uiBootstrapSchema.safeParse({
        ...validBootstrap,
        ui: { enabled: true },
      }).success,
    ).toBe(false);
    expect(
      uiBootstrapSchema.safeParse({
        ...validBootstrap,
        authentication: {
          enabled: true,
          authenticated: true,
          mode: "session",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects migration entries with missing OpenAPI-required controls", () => {
    expect(
      migrationFeatureSchema.safeParse({
        feature_id: "routing.rules",
        title: "라우팅 규칙",
        app_path: "/app/routing/rules",
        legacy_path: "/admin#/routing",
        status: "preview",
        risk_level: "high",
        available: true,
      }).success,
    ).toBe(false);
  });

  it("accepts Provider list and SLO read contracts without secret material", () => {
    const providers = providerListSchema.parse({
      providers: [
        {
          name: "openai",
          provider_ref: providerRef,
          base_url: "https://api.openai.example/v1",
          api_key_configured: true,
          timeout_ms: 15_000,
          enabled: true,
          model_patterns: "gpt-*",
          failover_group: "primary",
          priority: 10,
          created_at: "2026-09-01T00:00:00Z",
        },
      ],
    });
    expect(providers.providers[0]).not.toHaveProperty("api_key");
    expect(providers.providers[0]?.provider_ref).toBe(providerRef);

    expect(
      providerListSchema.safeParse({
        providers: [{ ...providers.providers[0], provider_ref: undefined }],
      }).success,
    ).toBe(false);

    const metric = { actual: 1, breached: false, enforced: true, target: 1 };
    const sloResponse = {
      slos: [
        {
          availability_target: 0.99,
          enabled: true,
          error_rate_target: 0.01,
          fallback_rate_target: 0.01,
          note: "production",
          p95_latency_target_ms: 800,
          provider: "openai",
          provider_ref: providerRef,
          updated_at: "2026-09-01T00:00:00Z",
        },
      ],
      evaluations: [
        {
          breached: false,
          enabled: true,
          metrics: {
            availability: metric,
            error_rate: metric,
            fallback_rate: metric,
            p95_latency_ms: metric,
          },
          provider: "openai",
          provider_ref: providerRef,
          requests: 10,
        },
      ],
      since: "2026-09-01T00:00:00Z",
    };
    expect(providerSLOResponseSchema.safeParse(sloResponse).success).toBe(true);
    expect(
      providerSLOResponseSchema.safeParse({
        ...sloResponse,
        slos: [{ ...sloResponse.slos[0], provider_ref: undefined }],
      }).success,
    ).toBe(false);
    expect(
      providerSLOResponseSchema.safeParse({
        ...sloResponse,
        evaluations: [{ ...sloResponse.evaluations[0], provider_ref: "openai" }],
      }).success,
    ).toBe(false);
  });

  it("requires opaque Provider references for Ops and every Routing health identity", () => {
    const score = {
      average_latency_ms: 120,
      fallback_rate: 0,
      fallbacks: 0,
      p95_latency_ms: 200,
      provider: "openai",
      provider_ref: providerRef,
      rate_429: 0,
      rate_5xx: 0,
      requests: 10,
      score: 90,
      timeouts: 0,
    };
    expect(providerHealthScoreSchema.safeParse(score).success).toBe(true);
    expect(providerHealthScoreSchema.safeParse({ ...score, provider_ref: undefined }).success).toBe(false);

    const routing = {
      alerts: [
        {
          code: "healthy",
          message: "healthy",
          provider: "openai",
          provider_ref: providerRef,
          severity: "info",
        },
      ],
      breakers: {
        cooldown_seconds: 30,
        enabled: true,
        instance_id: "gateway-1",
        shared: false,
        states: [
          {
            failures: 0,
            opens: 0,
            phase: "closed",
            provider: "openai",
            provider_ref: providerRef,
          },
        ],
        threshold: 5,
      },
      degraded: [score],
      providers: [score],
      ranking: [
        {
          average_latency_ms: 120,
          fallback_rate: 0,
          p95_latency_ms: 200,
          provider: "openai",
          provider_ref: providerRef,
          rank: 1,
          requests: 10,
          score: 90,
        },
      ],
      since: "2026-09-01T00:00:00Z",
      threshold: 70,
      trend: [
        {
          providers: [score],
          since: "2026-09-01T00:00:00Z",
          until: "2026-09-01T01:00:00Z",
        },
      ],
      until: "2026-09-01T01:00:00Z",
    } as const;
    expect(routingHealthSchema.safeParse(routing).success).toBe(true);
    expect(
      routingHealthSchema.safeParse({
        ...routing,
        ranking: [{ ...routing.ranking[0], provider_ref: undefined }],
      }).success,
    ).toBe(false);
    expect(
      routingHealthSchema.safeParse({
        ...routing,
        alerts: [{ ...routing.alerts[0], provider_ref: undefined }],
      }).success,
    ).toBe(false);
    expect(
      routingHealthSchema.safeParse({
        ...routing,
        breakers: {
          ...routing.breakers,
          states: [{ ...routing.breakers.states[0], provider_ref: undefined }],
        },
      }).success,
    ).toBe(false);
  });

  it("validates the strict Model catalogue including required shadow metadata", () => {
    const response = {
      generated_at: "2026-09-02T00:00:00Z",
      models: [
        {
          created: 1_700_000_000,
          deprecation: null,
          fetched_at: "2026-09-02T00:00:00Z",
          id: "gpt-5",
          object: "model",
          owned_by: "openai",
          provider: "openai",
          provider_ref: `prv_${"a".repeat(43)}`,
          shadowed: true,
          shadowed_by: "agent-route-priority",
          source: "live",
          stale: false,
          virtual: false,
        },
      ],
      partial_failures: [],
      providers: [
        {
          fetched_at: "2026-09-02T00:00:00Z",
          model_count: 1,
          provider: "openai",
          provider_ref: `prv_${"a".repeat(43)}`,
          source: "live",
          stale: false,
          status: "ok",
        },
      ],
      request_id: "req-models-1",
    };
    expect(adminModelsResponseSchema.safeParse(response).success).toBe(true);
    expect(
      adminModelsResponseSchema.safeParse({
        ...response,
        models: [{ ...response.models[0], created: Number.MAX_SAFE_INTEGER }],
      }).success,
    ).toBe(true);
    expect(
      adminModelsResponseSchema.safeParse({
        ...response,
        models: [{ ...response.models[0], created: Number.MAX_SAFE_INTEGER + 1 }],
      }).success,
    ).toBe(false);
    expect(
      adminModelsResponseSchema.safeParse({
        ...response,
        models: [{ ...response.models[0], provider_ref: "openai" }],
      }).success,
    ).toBe(false);
    expect(adminModelsResponseSchema.safeParse({ ...response, leaked_secret: "no" }).success).toBe(false);
    const model = response.models[0];
    if (!model) throw new Error("expected a Model fixture");
    const modelWithoutShadowed: Record<string, unknown> = { ...model };
    delete modelWithoutShadowed.shadowed;
    expect(
      adminModelsResponseSchema.safeParse({
        ...response,
        models: [modelWithoutShadowed],
      }).success,
    ).toBe(false);
    const modelWithoutShadowedBy: Record<string, unknown> = { ...model };
    delete modelWithoutShadowedBy.shadowed_by;
    expect(
      adminModelsResponseSchema.safeParse({
        ...response,
        models: [modelWithoutShadowedBy],
      }).success,
    ).toBe(false);
    expect(
      adminModelsResponseSchema.safeParse({
        ...response,
        models: [{ ...response.models[0], unexpected: true }],
      }).success,
    ).toBe(false);
  });

  it("validates strict Model quality, pricing, and usage-tag responses", () => {
    expect(
      modelQualityResponseSchema.safeParse({
        categories: ["tests"],
        models: [
          {
            categories: { tests: { pass_rate: 1, samples: 2 } },
            eval_pass_rate: 1,
            eval_samples: 2,
            golden_pass_rate: 0.5,
            golden_samples: 2,
            model: "gpt-5",
            quality_score: 90,
            requests: 10,
            success_rate: 0.9,
          },
        ],
        since: "2026-09-01T00:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      pricingResponseSchema.safeParse({
        effective: {
          "gpt-5": {
            cached_input_krw_per_1m: 100,
            input_krw_per_1m: 1_000,
            output_krw_per_1m: 2_000,
          },
        },
        versions: [],
      }).success,
    ).toBe(true);
    expect(
      modelUsageTagsResponseSchema.safeParse({
        tags: [
          {
            avoid_for: "",
            good_for: "coding",
            model: "gpt-5",
            risk_note: "",
            updated_at: "2026-09-02T00:00:00Z",
            updated_by: "admin",
          },
        ],
      }).success,
    ).toBe(true);
    expect(modelUsageTagsResponseSchema.safeParse({ tags: [], extra: true }).success).toBe(false);
  });
});
