import { describe, expect, it } from "vitest";

import {
  buildProviderRows,
  displayProviderBaseURL,
  filterProviderRows,
  invalidProviderURLDisplay,
  providerSearchContainsSensitiveValue,
} from "@/features/gateway/providers/provider-catalog";
import type { Provider, ProviderSLOEvaluation } from "@/shared/api/schemas";

const provider = (name: string, enabled = true): Provider => ({
  name,
  base_url: `https://${name}.example/v1`,
  api_key_configured: true,
  timeout_ms: 15_000,
  enabled,
  model_patterns: `${name}-*`,
  failover_group: "primary",
  priority: 100,
  created_at: "2026-09-01T00:00:00Z",
});

const evaluation = (providerName: string, breached: boolean): ProviderSLOEvaluation => ({
  provider: providerName,
  requests: 10,
  enabled: true,
  breached,
  metrics: {
    availability: { target: 0.99, actual: breached ? 0.9 : 1, breached, enforced: true },
    p95_latency_ms: { target: 500, actual: 400, breached: false, enforced: true },
    error_rate: { target: 0.01, actual: 0, breached: false, enforced: true },
    fallback_rate: { target: 0.01, actual: 0, breached: false, enforced: true },
  },
});

describe("provider catalog", () => {
  it("uses available SLO evidence without treating disabled or unevaluated providers as healthy", () => {
    const rows = buildProviderRows(
      [provider("healthy"), provider("degraded"), provider("unknown"), provider("disabled", false)],
      [],
      [evaluation("healthy", false), evaluation("degraded", true)],
    );

    expect(rows.map(({ health }) => health)).toEqual(["healthy", "degraded", "unknown", "unknown"]);
  });

  it("marks enabled providers as Checking while the selected range is loading", () => {
    const rows = buildProviderRows(
      [provider("enabled"), provider("disabled", false)],
      [],
      [evaluation("enabled", false)],
      undefined,
      true,
    );

    expect(rows.map(({ health }) => health)).toEqual(["checking", "unknown"]);
    expect(filterProviderRows(rows, "", "healthy").map((row) => row.provider.name)).toEqual(["enabled"]);
  });

  it("filters normalized text and configuration or health states", () => {
    const rows = buildProviderRows(
      [provider("Alpha"), provider("Beta", false)],
      [],
      [evaluation("Alpha", false)],
    );

    expect(filterProviderRows(rows, "ALPHA", "healthy").map((row) => row.provider.name)).toEqual(["Alpha"]);
    expect(filterProviderRows(rows, "primary", "disabled").map((row) => row.provider.name)).toEqual(["Beta"]);
  });

  it("masks credentials and secret-like query values in displayed base URLs", () => {
    const displayed = displayProviderBaseURL(
      "https://operator:password@provider.example/v1?api-version=2026-01-01&secretKey=one&passwordHash=two&authToken=three&credentialId=four&signatureVersion=five&clientSecretValue=seven#token=six",
    );

    for (const secret of ["operator", "password@", "one", "two", "three", "four", "five", "six", "seven"]) {
      expect(displayed).not.toContain(secret);
    }
    expect(displayed).toContain("api-version=2026-01-01");
    expect(displayProviderBaseURL("not a URL secret=private")).toBe(invalidProviderURLDisplay);
  });

  it("searches only the sanitized URL and detects credential-bearing search input", () => {
    const unsafeProvider = {
      ...provider("legacy"),
      base_url: "https://operator:password@provider.example/v1?api-version=2026-01-01&token=private#secret",
    };
    const rows = buildProviderRows([unsafeProvider]);

    expect(filterProviderRows(rows, "private", "all")).toEqual([]);
    expect(filterProviderRows(rows, "provider.example", "all")).toHaveLength(1);
    for (const unsafe of [
      unsafeProvider.base_url,
      "api_key=private",
      "credentialId:private",
      "Bearer private",
      "sk-private12345678",
      "https://provider.example/v1/sk-private12345678",
      "https://provider.example/v1?foo=sk-private12345678",
      "eyJheader.eyJpayload.signature",
    ]) {
      expect(providerSearchContainsSensitiveValue(unsafe)).toBe(true);
    }
    expect(providerSearchContainsSensitiveValue("api-version=2026-01-01")).toBe(false);
    expect(providerSearchContainsSensitiveValue("provider.example")).toBe(false);
  });
});
