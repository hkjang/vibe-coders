import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { GatewayHealthPage } from "@/features/gateway/health/GatewayHealthPage";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { RoutingHealth } from "@/shared/api/schemas";
import { usePreferences } from "@/shared/stores/preferences";

const authRuntime = vi.hoisted(() => ({ legacyFallback: true }));

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    authenticationMode: "session",
    legacyFallback: authRuntime.legacyFallback,
    mode: "authenticated",
    user: { scopes: ["admin:read", "routing:read"] },
  }),
}));

const provider = {
  provider: "openai",
  score: 62,
  requests: 120,
  average_latency_ms: 420,
  p95_latency_ms: 810,
  timeouts: 2,
  rate_429: 1,
  rate_5xx: 3,
  fallbacks: 6,
  fallback_rate: 0.05,
} satisfies RoutingHealth["providers"][number];

const routingHealth = {
  since: "2026-09-01T00:00:00Z",
  until: "2026-09-02T00:00:00Z",
  threshold: 70,
  providers: [provider],
  ranking: [
    {
      rank: 1,
      provider: "openai",
      score: 62,
      requests: 120,
      fallback_rate: 0.05,
      p95_latency_ms: 810,
      average_latency_ms: 420,
    },
  ],
  degraded: [provider],
  alerts: [
    {
      provider: "openai",
      code: "provider_degraded",
      severity: "warning",
      message: "Provider 상태 점수가 임계값보다 낮습니다.",
    },
  ],
  trend: [],
  breakers: {
    enabled: true,
    threshold: 3,
    cooldown_seconds: 30,
    states: [
      {
        provider: "openai",
        phase: "open",
        failures: 3,
        opens: 1,
        last_reason: "upstream timeout",
        retry_in_seconds: 12,
      },
    ],
    shared: true,
    instance_id: "gateway-1",
  },
} satisfies RoutingHealth;

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderPage(
  initialEntry = "/gateway/health",
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/gateway/health"
            element={
              <>
                <GatewayHealthPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

interface ApiScenario {
  failRoutingOnce?: boolean;
}

function mockApi({ failRoutingOnce = false }: ApiScenario = {}): {
  request: ReturnType<typeof vi.spyOn>;
  routingAttempts: () => number;
} {
  let routingAttempts = 0;
  const request = vi.spyOn(apiClient, "request").mockImplementation(async (endpoint) => {
    if (endpoint.path === endpoints.health.path) return { status: "ok" } as never;
    if (endpoint.path === endpoints.ready.path) return { status: "ready" } as never;
    if (endpoint.path === endpoints.admin.routing.health.path) {
      routingAttempts += 1;
      if (failRoutingOnce && routingAttempts === 1) {
        throw new AppError("라우팅 상태를 불러오지 못했습니다.", {
          kind: "http",
          requestId: "req-routing-503",
          retryable: true,
          status: 503,
        });
      }
      return routingHealth as never;
    }
    throw new Error(`Unexpected endpoint: ${endpoint.path}`);
  });
  return { request, routingAttempts: () => routingAttempts };
}

describe("GatewayHealthPage", () => {
  beforeEach(() => {
    authRuntime.legacyFallback = true;
    usePreferences.setState({ refreshInterval: 0 });
    vi.restoreAllMocks();
  });

  it("stores the range in the URL and renders ranking, breaker and alerts as accessible data", async () => {
    const user = userEvent.setup();
    const { request } = mockApi();
    renderPage("/gateway/health?team=platform&range=7d");

    expect(screen.getByRole("button", { name: "7일" })).toHaveAttribute("aria-pressed", "true");
    const ranking = await screen.findByRole("table", {
      name: "선택 기간의 Provider 상태 점수 순위",
    });
    expect(within(ranking).getByText("openai")).toBeInTheDocument();
    expect(within(ranking).getByText("62점")).toBeInTheDocument();

    const breakers = screen.getByRole("table", { name: "Provider별 Circuit Breaker 상태" });
    expect(within(breakers).getByText("차단(Open)")).toBeInTheDocument();
    expect(screen.getByText("Provider 상태 점수가 임계값보다 낮습니다.")).toBeInTheDocument();
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Legacy 상태 열기/ })).toHaveAttribute(
      "href",
      "/admin#/routing/health",
    );

    expect(request).toHaveBeenCalledWith(
      endpoints.admin.routing.health,
      expect.objectContaining({ query: { threshold: 70, window: "7d" } }),
    );

    await user.click(screen.getByRole("button", { name: "30일" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/gateway/health?team=platform&range=30d");
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        endpoints.admin.routing.health,
        expect.objectContaining({ query: { threshold: 70, window: "30d" } }),
      ),
    );
  });

  it("keeps successful widgets visible when routing fails and retries only the failed query", async () => {
    const user = userEvent.setup();
    const { routingAttempts } = mockApi({ failRoutingOnce: true });
    renderPage();

    expect(await screen.findByText("API 연결 가능")).toBeInTheDocument();
    expect(screen.getByText("요청 수신 가능")).toBeInTheDocument();
    expect(screen.getByText("라우팅 상태를 불러오지 못했습니다.")).toBeInTheDocument();
    expect(screen.getByText("Request ID: req-routing-503")).toBeInTheDocument();
    expect(screen.getByText("Degraded")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Provider 라우팅 상태 재시도" }));
    expect(await screen.findByRole("table", { name: "Provider별 Circuit Breaker 상태" })).toBeVisible();
    expect(routingAttempts()).toBe(2);
  });

  it("refreshes all independent queries manually and hides an unauthorized Legacy bridge", async () => {
    const user = userEvent.setup();
    authRuntime.legacyFallback = false;
    const { request } = mockApi();
    renderPage();

    await screen.findByRole("table", { name: "선택 기간의 Provider 상태 점수 순위" });
    expect(screen.queryByRole("link", { name: /Legacy 상태 열기/ })).not.toBeInTheDocument();
    expect(screen.getByText("Read Only")).toBeInTheDocument();

    request.mockClear();
    await user.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request).toHaveBeenCalledWith(
      endpoints.health,
      expect.objectContaining({ routeId: "gateway.health" }),
    );
    expect(request).toHaveBeenCalledWith(
      endpoints.ready,
      expect.objectContaining({ routeId: "gateway.health" }),
    );
    expect(request).toHaveBeenCalledWith(
      endpoints.admin.routing.health,
      expect.objectContaining({ routeId: "gateway.health" }),
    );
  });

  it("reports a failed background liveness refresh as stale and degraded, not disconnected", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["gateway", "health"], { status: "ok" }, { updatedAt: Date.now() - 20_000 });
    vi.spyOn(apiClient, "request").mockImplementation(async (endpoint) => {
      if (endpoint.path === endpoints.health.path) {
        throw new AppError("상태 갱신 실패", {
          kind: "network",
          requestId: "req-health-stale",
          retryable: true,
        });
      }
      if (endpoint.path === endpoints.ready.path) return { status: "ready" } as never;
      if (endpoint.path === endpoints.admin.routing.health.path) return routingHealth as never;
      throw new Error(`Unexpected endpoint: ${endpoint.path}`);
    });

    renderPage("/gateway/health", client);

    expect(await screen.findByText(/마지막 정상 데이터를 표시합니다/)).toBeVisible();
    expect(screen.getByText("Request ID: req-health-stale")).toBeVisible();
    expect(screen.getAllByText("Degraded").length).toBeGreaterThan(0);
    expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
    expect(screen.getByText("API 연결 가능")).toBeVisible();
  });

  it("has no automated accessibility violations", async () => {
    mockApi();
    const { container } = renderPage();

    await screen.findByRole("table", { name: "선택 기간의 Provider 상태 점수 순위" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
