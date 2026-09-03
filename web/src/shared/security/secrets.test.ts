import { describe, expect, it } from "vitest";

import { containsPotentialSecret, isSensitiveCredentialKey } from "@/shared/security/secrets";

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
  ])("allows ordinary search text: %s", (value) => {
    expect(containsPotentialSecret(value)).toBe(false);
  });

  it("fails closed when bounded decoding cannot reach a fixed point or input is excessive", () => {
    expect(containsPotentialSecret(encoded("api_key=too-deep", 10))).toBe(true);
    expect(containsPotentialSecret("x".repeat(16_385))).toBe(true);
  });
});
