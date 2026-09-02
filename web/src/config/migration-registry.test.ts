import { describe, expect, it } from "vitest";

import {
  featureByPath,
  isAppFeatureImplemented,
  migrationRegistry,
  registryFromBootstrap,
  resolveFeature,
  rolloutBucket,
  versionAtLeast,
} from "@/config/migration-registry";
import type { AuthUser } from "@/shared/api/schemas";
import type { UIBootstrapFeature } from "@/shared/api/schemas";

const operator: AuthUser = {
  id: "operator-1",
  email: "operator@example.test",
  role: "operator",
  roles: ["operator"],
  team_id: "ops",
  scopes: ["admin:read"],
  features: {},
};

describe("migration registry", () => {
  const serverContract = [
    ["overview", "/app/overview"],
    ["gateway.providers", "/app/gateway/providers"],
    ["gateway.models", "/app/gateway/models"],
    ["routing.rules", "/app/routing/rules"],
    ["observability.requests", "/app/observability/requests"],
    ["observability.traces", "/app/observability/traces"],
    ["prompts.lab", "/app/prompts/lab"],
    ["access.users", "/app/access/users"],
    ["governance.policies", "/app/governance/policies"],
    ["mcp.overview", "/app/mcp"],
    ["text2sql.overview", "/app/text2sql"],
    ["finops.overview", "/app/finops"],
    ["security.overview", "/app/security"],
    ["system.settings", "/app/system/settings"],
  ] as const;

  it("compares release versions numerically", () => {
    expect(versionAtLeast("v0.80.0", "v0.79.8")).toBe(true);
    expect(versionAtLeast("v0.79.7", "v0.79.8")).toBe(false);
  });

  it("uses a deterministic rollout bucket", () => {
    expect(rolloutBucket("user-1", "overview")).toBe(rolloutBucket("user-1", "overview"));
    expect(rolloutBucket("user-1", "overview")).toBeGreaterThanOrEqual(0);
    expect(rolloutBucket("user-1", "overview")).toBeLessThan(100);
  });

  it("denies a feature when the effective permission is missing", () => {
    const routing = migrationRegistry.find((feature) => feature.featureId === "routing.rules");
    if (!routing) throw new Error("routing.rules fixture is missing");
    const effective = resolveFeature(routing, operator, "v0.80.0");
    expect(effective.permitted).toBe(false);
    expect(effective.reason).toBe("routing:read");
  });

  it("maps nested client-side routes back to a registry feature", () => {
    expect(featureByPath("/routing/rules/decision-1")?.featureId).toBe("routing.rules");
  });

  it("keeps runtime promotions on Legacy when this UI build has no matching screen", () => {
    const provider = migrationRegistry.find((feature) => feature.featureId === "gateway.providers");
    if (!provider) throw new Error("gateway.providers fixture is missing");
    const effective = resolveFeature(
      { ...provider, status: "stable", serverAvailable: true },
      operator,
      "v0.80.0",
    );
    expect(isAppFeatureImplemented(provider.featureId)).toBe(false);
    expect(effective).toMatchObject({ permitted: true, status: "legacy", reason: "ui_not_implemented" });
  });

  it("keeps an implemented Retired feature available only in the app", () => {
    const overview = migrationRegistry.find((feature) => feature.featureId === "overview");
    if (!overview) throw new Error("overview fixture is missing");
    const effective = resolveFeature(
      { ...overview, status: "retired", serverAvailable: true },
      operator,
      "v0.80.0",
    );
    expect(effective).toMatchObject({ permitted: true, status: "retired" });
  });

  it("fails closed when an unimplemented feature is Retired or Legacy fallback is disabled", () => {
    const provider = migrationRegistry.find((feature) => feature.featureId === "gateway.providers");
    if (!provider) throw new Error("gateway.providers fixture is missing");
    expect(
      resolveFeature({ ...provider, status: "retired", serverAvailable: true }, operator, "v0.80.0"),
    ).toMatchObject({ permitted: false, reason: "ui_not_implemented" });
    expect(resolveFeature(provider, operator, "v0.80.0", { legacyFallback: false })).toMatchObject({
      permitted: false,
      reason: "legacy_fallback_disabled",
    });
  });

  it("keeps all 14 fallback IDs and paths aligned with the authoritative server registry", () => {
    expect(migrationRegistry.map(({ featureId, appPath }) => [featureId, appPath])).toEqual(serverContract);
    const payload: UIBootstrapFeature[] = serverContract.map(([featureId, appPath]) => {
      const fallback = migrationRegistry.find((feature) => feature.featureId === featureId);
      if (!fallback) throw new Error(`missing fallback feature ${featureId}`);
      return {
        feature_id: featureId,
        title: fallback.title,
        app_path: appPath,
        legacy_path: fallback.legacyPath,
        status: fallback.status,
        risk_level: fallback.riskLevel,
        required_permission: fallback.requiredPermission ?? "",
        read_only: fallback.readOnly,
        enabled_roles: [...fallback.enabledRoles],
        rollout_percent: fallback.rolloutPercent,
        fallback_enabled: fallback.fallbackEnabled,
        minimum_api_version: fallback.minimumApiVersion,
        available: true,
      };
    });
    expect(registryFromBootstrap(payload).map(({ featureId, appPath }) => [featureId, appPath])).toEqual(
      serverContract,
    );
  });
});
