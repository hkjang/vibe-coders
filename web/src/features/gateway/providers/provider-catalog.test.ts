import { describe, expect, it } from "vitest";

import {
  buildProviderRows,
  displayProviderBaseURL,
  filterProviderRows,
  invalidProviderURLDisplay,
  providerSearchContainsSensitiveValue,
} from "@/features/gateway/providers/provider-catalog";
import type { Provider, ProviderSLO, ProviderSLOEvaluation, RoutingHealth } from "@/shared/api/schemas";

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

const slo = (providerName: string): ProviderSLO => ({
  provider: providerName,
  availability_target: 0.99,
  p95_latency_target_ms: 500,
  error_rate_target: 0.01,
  fallback_rate_target: 0.01,
  enabled: true,
  note: "production",
  updated_at: "2026-09-01T00:00:00Z",
});

function routingHealth(providerName: string): RoutingHealth {
  const score = {
    provider: providerName,
    score: 20,
    requests: 10,
    average_latency_ms: 400,
    p95_latency_ms: 600,
    timeouts: 1,
    rate_429: 0,
    rate_5xx: 1,
    fallbacks: 1,
    fallback_rate: 0.1,
  };
  return {
    since: "2026-09-01T00:00:00Z",
    until: "2026-09-02T00:00:00Z",
    threshold: 70,
    providers: [score],
    ranking: [],
    degraded: [score],
    alerts: [],
    trend: [],
    breakers: {
      enabled: true,
      threshold: 3,
      cooldown_seconds: 30,
      states: [],
      shared: true,
      instance_id: "gateway-1",
    },
  };
}

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
    expect(filterProviderRows(rows, "", "healthy")).toEqual([]);
    expect(filterProviderRows(rows, "", "degraded")).toEqual([]);
    expect(filterProviderRows(rows, "", "unknown").map((row) => row.provider.name)).toEqual(["disabled"]);
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

  it("projects unsafe legacy names to distinct opaque identities without assigning redacted health", () => {
    const firstName = "sk-ant-first-private-value";
    const secondName = "Bearer second-private-value";
    const reservedName = "[provider-name-omitted]";
    const unsafeProviders = [firstName, secondName, reservedName].map((name) => ({
      ...provider("legacy"),
      name,
      base_url: "https://legacy.example/v1",
      model_patterns: "legacy-*",
    }));
    const rows = buildProviderRows(
      unsafeProviders,
      unsafeProviders.map(({ name }) => slo(name)),
      unsafeProviders.map(({ name }) => evaluation(name, true)),
      routingHealth("[provider-name-omitted]"),
    );

    expect(new Set(rows.map((row) => row.identity)).size).toBe(3);
    expect(rows.every((row) => row.nameRedacted)).toBe(true);
    expect(rows.every((row) => row.displayName.startsWith("Provider 이름 비공개 "))).toBe(true);
    expect(rows.every((row) => row.identity.startsWith("redacted-provider-"))).toBe(true);
    expect(rows.map((row) => row.health)).toEqual(["unknown", "unknown", "unknown"]);
    expect(rows.every((row) => !row.routing && !row.slo && !row.evaluation)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(firstName);
    expect(JSON.stringify(rows)).not.toContain(secondName);
    expect(JSON.stringify(rows)).not.toContain(reservedName);
    expect(filterProviderRows(rows, "first-private", "all")).toEqual([]);
    expect(filterProviderRows(rows, "이름 비공개", "unknown")).toHaveLength(3);

    const rebuilt = buildProviderRows(unsafeProviders);
    expect(rebuilt.map((row) => row.identity)).toEqual(rows.map((row) => row.identity));

    const safeRow = buildProviderRows([provider("safe")], [], [], routingHealth("safe"))[0];
    if (!safeRow) throw new Error("Expected a safe Provider row");
    expect(safeRow).toMatchObject({
      displayName: "safe",
      health: "degraded",
      identity: "safe",
      nameRedacted: false,
      routing: { provider: "safe" },
    });
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
