import { describe, expect, it } from "vitest";

import {
  adminModelsResponseSchema,
  migrationFeatureSchema,
  modelQualityResponseSchema,
  modelUsageTagsResponseSchema,
  pricingResponseSchema,
  providerListSchema,
  providerSLOResponseSchema,
  uiBootstrapSchema,
} from "@/shared/api/schemas";

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

    expect(
      providerSLOResponseSchema.safeParse({
        slos: [],
        evaluations: [],
        since: "2026-09-01T00:00:00Z",
      }).success,
    ).toBe(true);
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
