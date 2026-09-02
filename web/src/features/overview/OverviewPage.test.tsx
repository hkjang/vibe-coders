import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverviewPage } from "@/features/overview/OverviewPage";
import { apiClient } from "@/shared/api/client";
import { endpoints, type ApiEndpointBase } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { usePreferences } from "@/shared/stores/preferences";

const authRuntime = vi.hoisted(() => ({
  legacyFallback: true,
  scopes: ["admin:read", "routing:read"],
}));

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    authenticationMode: "session",
    backendVersion: "v0.81.0",
    legacyFallback: authRuntime.legacyFallback,
    mode: "authenticated",
    user: { scopes: authRuntime.scopes },
  }),
}));

const provider = {
  provider: "openai",
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

const operations = {
  generated_at: "2026-09-02T01:02:03Z",
  providers: [provider],
  logging: { queue_depth: 2, written: 100, dropped: 0 },
  fallback: {
    path: "/data/fallback.ndjson",
    exists: true,
    lines: 4,
    bytes: 2_048,
    modified_at: "2026-09-02T01:00:00Z",
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

const stats = {
  total_requests: 12,
  total_tokens: 300,
  total_cost_krw: 4_200,
  average_latency_ms: 125.2,
  by_ip: [],
  by_model: [],
  by_language: [],
  by_status: [{ class: "2xx", requests: 9 }],
  top_users: [],
  latency_quantiles: { p50: 100, p95: 250, p99: 400 },
  first_chunk_quantiles: { p50: 20, p95: 50, p99: 80 },
  cache: { entries: 1, bytes: 256, total_hits: 3, top_models: [] },
  failover_total: 2,
  cache_hits: 3,
  cache_misses: 1,
} as const;

const routing = {
  since: "2026-09-02T00:00:00Z",
  until: "2026-09-02T01:00:00Z",
  threshold: 70,
  providers: [provider],
  ranking: [
    {
      rank: 1,
      provider: "openai",
      score: 92,
      requests: 120,
      fallback_rate: 0.025,
      p95_latency_ms: 280,
      average_latency_ms: 180.5,
    },
  ],
  degraded: [],
  alerts: [],
  trend: [],
  breakers: {
    enabled: true,
    threshold: 5,
    cooldown_seconds: 30,
    states: [],
    shared: false,
    instance_id: "gateway-1",
  },
} as const;

function mockPhaseOneApi(
  failingPath?: string,
  routingWindows?: string[],
  riskTier: "low" | "medium" = "low",
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(apiClient, "request").mockImplementation((async (
    endpoint: ApiEndpointBase,
    options?: { readonly query?: { readonly window?: string } },
  ) => {
    if (endpoint.path === failingPath) {
      throw new AppError("위험 신호를 조회할 수 없습니다.", {
        kind: "http",
        requestId: "req-overview-42",
        status: 503,
      });
    }
    if (endpoint.path === endpoints.health.path) return { status: "ok" };
    if (endpoint.path === endpoints.admin.stats.path) return stats;
    if (endpoint.path === endpoints.admin.routing.health.path) {
      if (options?.query?.window) routingWindows?.push(options.query.window);
      return routing;
    }
    if (endpoint.path === endpoints.admin.ops.risk.path) {
      return {
        risk: {
          score: riskTier === "medium" ? 20 : 10,
          tier: riskTier,
          factors:
            riskTier === "medium"
              ? [{ key: "disk_warning", points: 10, severity: "warning", message: "디스크 확인 필요" }]
              : [],
        },
        status: operations,
      };
    }
    throw new Error(`unexpected request ${endpoint.path}`);
  }) as typeof apiClient.request);
}

function renderOverview(initialEntry = "/app/overview"): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={client}>
        <OverviewPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("OverviewPage", () => {
  beforeEach(() => {
    authRuntime.legacyFallback = true;
    authRuntime.scopes = ["admin:read", "routing:read"];
    usePreferences.setState({ refreshInterval: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows live cumulative and selected-range operating signals", async () => {
    mockPhaseOneApi();
    renderOverview();

    expect(await screen.findByText("12")).toBeVisible();
    expect(screen.getByText("₩4,200")).toBeVisible();
    expect(screen.getAllByText("Healthy").length).toBeGreaterThan(0);
    expect(screen.getByText("Legacy에서 열기")).toHaveAttribute("href", "/admin#/dashboard");
    expect(screen.getByText("보존 데이터")).toBeVisible();
    expect(screen.getByText("재시작 후")).toBeVisible();
    expect(screen.getByText("현재 Gateway 프로세스 시작 이후 로컬 지표")).toBeVisible();
    expect(
      vi
        .mocked(apiClient.request)
        .mock.calls.some(([endpoint]) => endpoint.path === endpoints.admin.ops.status.path),
    ).toBe(false);
  });

  it("keeps healthy widgets visible when one endpoint fails", async () => {
    mockPhaseOneApi(endpoints.admin.ops.risk.path);
    renderOverview();

    expect((await screen.findAllByText("Request ID: req-overview-42")).length).toBeGreaterThan(0);
    expect(screen.getByText("12")).toBeVisible();
    expect(screen.getByRole("button", { name: "운영 위험 재시도" })).toBeEnabled();
    expect(screen.getAllByText("Degraded").length).toBeGreaterThan(0);
  });

  it("marks cached health data as degraded when its refresh fails", async () => {
    let healthRequests = 0;
    vi.spyOn(apiClient, "request").mockImplementation((async (
      endpoint: ApiEndpointBase,
      options?: { readonly query?: { readonly window?: string } },
    ) => {
      if (endpoint.path === endpoints.health.path) {
        healthRequests += 1;
        if (healthRequests > 1) {
          throw new AppError("Gateway 상태를 갱신할 수 없습니다.", {
            kind: "network",
            requestId: "req-health-refresh",
          });
        }
        return { status: "ok" };
      }
      if (endpoint.path === endpoints.admin.stats.path) return stats;
      if (endpoint.path === endpoints.admin.routing.health.path) {
        if (options?.query?.window) return routing;
        return routing;
      }
      if (endpoint.path === endpoints.admin.ops.risk.path) {
        return { risk: { score: 10, tier: "low", factors: [] }, status: operations };
      }
      throw new Error(`unexpected request ${endpoint.path}`);
    }) as typeof apiClient.request);
    const user = userEvent.setup();
    renderOverview();

    expect((await screen.findAllByText("Healthy")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "전체 새로고침" }));

    expect(await screen.findByText("새 상태 갱신에 실패해 마지막 정상 응답을 표시합니다.")).toBeVisible();
    expect(screen.getAllByText("Degraded").length).toBeGreaterThan(0);
    expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
  });

  it("does not render duplicate errors for two cards backed by the same stats query", async () => {
    mockPhaseOneApi(endpoints.admin.stats.path);
    renderOverview();

    expect(await screen.findAllByText("Request ID: req-overview-42")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "보존 트래픽과 비용 재시도" })).toHaveLength(1);
    expect(screen.queryByText("프로세스 런타임")).not.toBeInTheDocument();
  });

  it("stays in Checking until every initial overview query settles", async () => {
    vi.spyOn(apiClient, "request").mockImplementation((async (endpoint: ApiEndpointBase) => {
      if (endpoint.path === endpoints.health.path) return { status: "ok" };
      return await new Promise<never>(() => undefined);
    }) as typeof apiClient.request);
    renderOverview();

    expect(await screen.findByText(/Gateway는 요청을 처리할 수 있으며/)).toHaveTextContent("Checking");
    expect(screen.getAllByText("Checking").length).toBeGreaterThan(0);
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
  });

  it("stores the routing range in the URL state and sends it to the API", async () => {
    const routingWindows: string[] = [];
    mockPhaseOneApi(undefined, routingWindows);
    const user = userEvent.setup();
    renderOverview("/app/overview?range=1h");

    expect(screen.getByRole("button", { name: "1시간" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "7일" }));

    await waitFor(() => expect(routingWindows).toContain("7d"));
  });

  it("does not request routing data without routing:read and explains the missing scope", async () => {
    authRuntime.scopes = ["admin:read"];
    mockPhaseOneApi();
    renderOverview();

    expect(await screen.findByText("라우팅 신호는 제한되어 있습니다.")).toBeVisible();
    expect(screen.getByText("관리자에게 routing:read 권한을 요청하세요.")).toBeVisible();
    expect(
      vi
        .mocked(apiClient.request)
        .mock.calls.some(([endpoint]) => endpoint.path === endpoints.admin.routing.health.path),
    ).toBe(false);
    expect(screen.queryByText("Degraded")).not.toBeInTheDocument();
  });

  it("hides the Legacy bridge when fallback is disabled", () => {
    authRuntime.legacyFallback = false;
    mockPhaseOneApi();
    renderOverview();

    expect(screen.queryByText("Legacy에서 열기")).not.toBeInTheDocument();
  });

  it("marks a medium operational risk as degraded", async () => {
    mockPhaseOneApi(undefined, undefined, "medium");
    renderOverview();

    await screen.findByText("MEDIUM");
    expect(screen.getAllByText("Degraded").length).toBeGreaterThan(0);
  });

  it("has no automated accessibility violations", async () => {
    mockPhaseOneApi();
    const { container } = renderOverview();

    await screen.findByText("₩4,200");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
