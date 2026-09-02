import { describe, expect, it } from "vitest";

import { migrationFeatureSchema, uiBootstrapSchema } from "@/shared/api/schemas";

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
});
