import { describe, expect, it } from "vitest";

import {
  buildProviderRows,
  displayProviderBaseURL,
  filterProviderRows,
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
      "https://operator:password@provider.example/v1?api_key=private&region=kr",
    );

    expect(displayed).not.toContain("operator");
    expect(displayed).not.toContain("password@");
    expect(displayed).not.toContain("private");
    expect(displayed).toContain("region=kr");
  });
});
