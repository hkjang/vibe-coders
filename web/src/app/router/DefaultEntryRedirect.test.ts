import { describe, expect, it } from "vitest";

import { resolveDefaultEntry } from "@/app/router/default-entry";
import { migrationRegistry } from "@/config/migration-registry";
import type { AuthUser } from "@/shared/api/schemas";

const user: AuthUser = {
  id: "operator-1",
  email: "operator@example.test",
  role: "viewer",
  roles: ["viewer"],
  team_id: "ops",
  scopes: ["admin:read"],
  features: {},
};

function context(legacyFallback = true) {
  return {
    features: migrationRegistry,
    user,
    backendVersion: "v0.80.0",
    legacyFallback,
  };
}

describe("runtime default entry", () => {
  it("accepts an exact registered and permitted feature", () => {
    expect(resolveDefaultEntry("/app/overview", context())).toBe("/overview");
  });

  it("rejects the app index and unknown or nested routes instead of redirecting to itself", () => {
    expect(resolveDefaultEntry("/app", context())).toBe("/overview");
    expect(resolveDefaultEntry("/app/not-registered", context())).toBe("/overview");
    expect(resolveDefaultEntry("/app/overview/not-a-route", context())).toBe("/overview");
  });

  it("falls back to Overview when the configured feature is not permitted", () => {
    expect(resolveDefaultEntry("/app/routing/rules", context())).toBe("/overview");
  });

  it("does not select a Legacy-only default when runtime fallback is disabled", () => {
    expect(resolveDefaultEntry("/app/gateway/providers", context(false))).toBe("/overview");
  });
});
