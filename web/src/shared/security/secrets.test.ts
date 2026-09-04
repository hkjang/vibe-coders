import { describe, expect, it } from "vitest";

import {
  containsPotentialSecret,
  isSensitiveCredentialKey,
  secretSearchMessage,
} from "@/shared/security/secrets";

function encoded(value: string, passes: number): string {
  let result = value;
  for (let pass = 0; pass < passes; pass += 1) result = encodeURIComponent(result);
  return result;
}

describe("secret detection", () => {
  it.each([
    "Authorization",
    "api_key",
    "authToken",
    "clientSecretValue",
    "credential-id",
    "kc_access",
    "kc_refresh",
    "passwordHash",
    "signatureVersion",
    "sig",
    "x-api-key",
  ])("recognizes credential-like keys: %s", (key) => {
    expect(isSensitiveCredentialKey(key)).toBe(true);
  });

  it.each([
    "Bearer private-value",
    "Bearer+private-value",
    "Basic dXNlcjpwYXNz",
    "Basic+dTpw",
    "Basic dG9rZW46",
    "Basic OnBhc3N3b3Jk",
    "Basic 6Tp4",
    "sk-proj-private12345678",
    `vc_sk_${"a".repeat(43)}`,
    `Vc_Sa_${"A1_-".repeat(11)}`,
    "eyJheader.eyJpayload.signature",
    "api_key=private",
    '"clientSecret": "private"',
    "credentialId:private",
    "https://operator:password@example.invalid/v1",
    "operator:password@example.invalid",
    "connect operator:password@example.invalid/v1",
    "next=operator:password@example.invalid",
    "https://example.invalid/v1?authToken=private",
    "#kc_access=private",
    "%61pi_key%3Dprivate",
    "/app/gateway/providers?q=%2561pi_key%253Dprivate",
    encoded("api_key=deep-private", 7),
    encoded("Bearer deep-private", 7),
    `ghp_${"A".repeat(36)}`,
    `github_pat_${"B".repeat(30)}`,
    `AKIA${"C".repeat(16)}`,
    `ASIA${"D".repeat(16)}`,
    `xoxb-${"E".repeat(24)}`,
    "xapp-1-A1234567890-B1234567890-C1234567890",
    `xwfp-${"W".repeat(24)}`,
    "xoxe.xoxb-1-1234567890-secretvalue",
    "xoxe-1-abcdefg",
    `AIza${"F".repeat(35)}`,
    "-----BEGIN PRIVATE KEY-----",
  ])("fails closed for a likely secret: %s", (value) => {
    expect(containsPotentialSecret(value)).toBe(true);
  });

  it.each([
    "",
    "api-version=2026-01-01",
    "operator:platform",
    "provider.example",
    "sk-short",
    "token budget report",
    "Basic auth",
    "Basic authentication",
    "ghp_preview",
    "AKIA-region",
    "xoxb-short",
    "xapp-short",
    "xwfp-short",
    "xoxe-short",
    "AIza-model",
  ])("allows ordinary search text: %s", (value) => {
    expect(containsPotentialSecret(value)).toBe(false);
  });

  it("fails closed when bounded decoding cannot reach a fixed point or input is excessive", () => {
    expect(containsPotentialSecret(encoded("api_key=too-deep", 10))).toBe(true);
    expect(containsPotentialSecret("x".repeat(16_385))).toBe(true);
  });

  it("detects generated credentials using runtime-configured prefixes", () => {
    const secret = `corp_${"A".repeat(43)}`;
    expect(containsPotentialSecret(secret, ["corp_"])).toBe(true);
    expect(containsPotentialSecret(secret, ["other_"])).toBe(false);
    expect(containsPotentialSecret("corp_model", ["corp_"])).toBe(false);
  });

  it("uses the explicit historical prefix registry without blocking long identifiers", () => {
    expect(containsPotentialSecret(`oldfoo_${"A".repeat(43)}`, ["corp_", "svc_", "oldfoo_"])).toBe(true);
    expect(containsPotentialSecret(`legacy${"A".repeat(43)}`, ["corp_", "svc_", "legacy"])).toBe(true);
    const longPrefix = "긴".repeat(129);
    expect(containsPotentialSecret(`${longPrefix}${"A".repeat(43)}`, [longPrefix])).toBe(true);
    expect(containsPotentialSecret("A".repeat(44), ["corp_", "svc_"])).toBe(false);
    expect(containsPotentialSecret(`model-${"A".repeat(43)}`, ["corp_", "svc_"])).toBe(false);
    expect(containsPotentialSecret(`req_${"a".repeat(43)}`, ["corp_", "svc_"])).toBe(false);
    expect(containsPotentialSecret(`trace-${"a".repeat(48)}`, ["corp_", "svc_"])).toBe(false);
  });

  it("provides a Korean remediation message", () => {
    expect(secretSearchMessage).toContain("비밀정보를 제거");
    expect(secretSearchMessage).not.toContain("Secret");
  });
});
