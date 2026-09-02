import { describe, expect, it } from "vitest";

import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";

describe("Legacy Admin access", () => {
  it("requires both runtime fallback and effective admin access", () => {
    expect(
      canOpenLegacyAdmin({ legacyFallback: true, mode: "authenticated", user: { scopes: ["admin:read"] } }),
    ).toBe(true);
    expect(
      canOpenLegacyAdmin({ legacyFallback: true, mode: "authenticated", user: { scopes: ["routing:read"] } }),
    ).toBe(false);
    expect(canOpenLegacyAdmin({ legacyFallback: false, mode: "open" })).toBe(false);
    expect(
      canOpenLegacyAdmin({
        authenticationMode: "legacy_token",
        legacyFallback: false,
        mode: "anonymous",
      }),
    ).toBe(false);
  });

  it("allows authenticated Legacy and open admin modes without a session user", () => {
    expect(canOpenLegacyAdmin({ legacyFallback: true, mode: "legacy" })).toBe(true);
    expect(canOpenLegacyAdmin({ legacyFallback: true, mode: "open" })).toBe(true);
    expect(
      canOpenLegacyAdmin({
        authenticationMode: "legacy_token",
        legacyFallback: true,
        mode: "anonymous",
      }),
    ).toBe(true);
  });
});
