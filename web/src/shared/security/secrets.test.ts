import { describe, expect, it } from "vitest";

import { containsPotentialSecret, isSensitiveCredentialKey } from "@/shared/security/secrets";

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
    "eyJheader.eyJpayload.signature",
    "api_key=private",
    '"clientSecret": "private"',
    "credentialId:private",
    "https://operator:password@example.invalid/v1",
    "https://example.invalid/v1?authToken=private",
    "#kc_access=private",
    "%61pi_key%3Dprivate",
    "/app/gateway/providers?q=%2561pi_key%253Dprivate",
  ])("fails closed for a likely secret: %s", (value) => {
    expect(containsPotentialSecret(value)).toBe(true);
  });

  it.each(["", "api-version=2026-01-01", "provider.example", "sk-short", "token budget report"])(
    "allows ordinary search text: %s",
    (value) => {
      expect(containsPotentialSecret(value)).toBe(false);
    },
  );
});
