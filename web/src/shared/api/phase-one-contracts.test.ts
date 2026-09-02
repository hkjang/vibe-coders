import { describe, expect, it } from "vitest";

import {
  adminStatsSchema,
  opsRiskResponseSchema,
  opsStatusSchema,
  readinessFailureSchema,
  readinessSchema,
  routingHealthQuerySchema,
  routingHealthSchema,
} from "@/shared/api/schemas";

const providerRef = (suffix: string): string => `prv_${suffix.padEnd(43, "x").slice(0, 43)}`;

const providerHealth = {
  provider: "openai",
  provider_ref: providerRef("openai"),
  score: 92,
  requests: 120,
  average_latency_ms: 180.5,
  p95_latency_ms: 280,
  timeouts: 1,
  rate_429: 2,
  rate_5xx: 0,
  fallbacks: 3,
  fallback_rate: 0.025,
} as const;

const opsStatus = {
  generated_at: "2026-09-02T01:02:03Z",
  providers: [providerHealth],
  logging: { queue_depth: 0, written: 100, dropped: 0 },
  fallback: {
    path: "/data/fallback.ndjson",
    exists: false,
    lines: 0,
    bytes: 0,
    modified_at: "",
  },
  security: {
    auth_enabled: true,
    dev_secret: false,
    raw_prompts_logged: false,
    raw_bodies_logged: false,
    pricing_configured: true,
  },
  disk: {
    path: "/data",
    available: true,
    free_bytes: 1_000_000,
    total_bytes: 2_000_000,
    used_percent: 50,
  },
} as const;

const adminStats = {
  total_requests: 12,
  total_tokens: 300,
  total_cost_krw: 42.5,
  average_latency_ms: 125.2,
  by_ip: [
    {
      key: "127.0.0.1",
      requests: 12,
      tokens: 300,
      cost_krw: 42.5,
      average_latency_ms: 125.2,
    },
  ],
  by_model: [],
  by_language: [{ language: "ko", requests: 12, average_confidence: 0.95 }],
  by_status: [{ class: "2xx", requests: 12 }],
  top_users: [],
  latency_quantiles: { p50: 100, p95: 250, p99: 400 },
  first_chunk_quantiles: { p50: 20, p95: 50, p99: 80 },
  cache: { entries: 1, bytes: 256, total_hits: 3, top_models: [] },
  failover_total: 0,
  cache_hits: 3,
  cache_misses: 1,
} as const;

const routingHealth = {
  since: "2026-09-02T00:00:00Z",
  until: "2026-09-02T01:00:00Z",
  threshold: 70,
  providers: [providerHealth],
  ranking: [
    {
      rank: 1,
      provider: "openai",
      provider_ref: providerRef("openai"),
      score: 92,
      requests: 120,
      fallback_rate: 0.025,
      p95_latency_ms: 280,
      average_latency_ms: 180.5,
    },
  ],
  degraded: [],
  alerts: [],
  trend: [
    {
      since: "2026-09-02T00:00:00Z",
      until: "2026-09-02T00:10:00Z",
      providers: [providerHealth],
    },
  ],
  breakers: {
    enabled: true,
    threshold: 5,
    cooldown_seconds: 30,
    states: [
      {
        provider: "backup",
        provider_ref: providerRef("backup"),
        phase: "open",
        failures: 5,
        opens: 1,
        last_reason: "timeout",
        last_failure_at: "2026-09-02T00:59:00Z",
        opened_at: "2026-09-02T00:59:00Z",
        retry_in_seconds: 15,
      },
    ],
    shared: false,
    instance_id: "gateway-1",
  },
} as const;

describe("Phase 1 API response contracts", () => {
  it("accepts health-adjacent readiness responses", () => {
    expect(readinessSchema.parse({ status: "ready" })).toEqual({ status: "ready" });
    expect(readinessFailureSchema.parse({ status: "not_ready", error: "database unavailable" })).toEqual({
      status: "not_ready",
      error: "database unavailable",
    });
  });

  it("accepts the complete admin stats response", () => {
    expect(adminStatsSchema.safeParse(adminStats).success).toBe(true);
  });

  it("rejects missing and incorrectly typed stats fields", () => {
    const { cache, ...withoutCache } = adminStats;
    void cache;
    expect(adminStatsSchema.safeParse(withoutCache).success).toBe(false);
    expect(adminStatsSchema.safeParse({ ...adminStats, total_requests: -1 }).success).toBe(false);
    expect(adminStatsSchema.safeParse({ ...adminStats, latency_quantiles: { p50: 1, p95: 2 } }).success).toBe(
      false,
    );
  });

  it("accepts ops status and its risk envelope", () => {
    expect(opsStatusSchema.safeParse(opsStatus).success).toBe(true);
    expect(
      opsRiskResponseSchema.safeParse({
        risk: {
          score: 10,
          tier: "low",
          factors: [{ key: "raw_bodies", points: 5, severity: "info", message: "raw body logging" }],
        },
        status: opsStatus,
      }).success,
    ).toBe(true);
  });

  it("preserves typed partial failures instead of treating unavailable data as empty", () => {
    const parsed = opsStatusSchema.parse({
      ...opsStatus,
      providers: [],
      partial_failures: [
        {
          component: "providers",
          code: "provider_health_unavailable",
          message: "Provider health data is temporarily unavailable.",
        },
      ],
    });

    expect(parsed.partial_failures).toEqual([
      {
        component: "providers",
        code: "provider_health_unavailable",
        message: "Provider health data is temporarily unavailable.",
      },
    ]);
    expect(
      opsStatusSchema.safeParse({
        ...opsStatus,
        partial_failures: [{ component: "providers", code: "unknown", message: "bad" }],
      }).success,
    ).toBe(false);
  });

  it("rejects invalid ops risk ranges and security field omissions", () => {
    expect(
      opsRiskResponseSchema.safeParse({
        risk: { score: 101, tier: "critical", factors: [] },
        status: opsStatus,
      }).success,
    ).toBe(false);
    expect(
      opsStatusSchema.safeParse({
        ...opsStatus,
        security: { auth_enabled: true },
      }).success,
    ).toBe(false);
  });

  it("accepts known windows and Go durations while rejecting unsafe query shapes", () => {
    expect(routingHealthQuerySchema.safeParse({ window: "24h", threshold: 70 }).success).toBe(true);
    expect(routingHealthQuerySchema.safeParse({ window: "90m" }).success).toBe(true);
    expect(routingHealthQuerySchema.safeParse({ threshold: 101 }).success).toBe(false);
    expect(routingHealthQuerySchema.safeParse({ window: "not-a-duration" }).success).toBe(false);
    expect(routingHealthQuerySchema.safeParse({ window: "1h", provider: "undeclared" }).success).toBe(false);
  });

  it("accepts routing health and rejects malformed breaker or timestamp data", () => {
    expect(routingHealthSchema.safeParse(routingHealth).success).toBe(true);
    expect(
      routingHealthSchema.safeParse({
        ...routingHealth,
        since: "yesterday",
      }).success,
    ).toBe(false);
    expect(
      routingHealthSchema.safeParse({
        ...routingHealth,
        breakers: {
          ...routingHealth.breakers,
          states: [
            {
              provider: "backup",
              provider_ref: providerRef("backup"),
              phase: "unknown",
              failures: 1,
              opens: 1,
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
