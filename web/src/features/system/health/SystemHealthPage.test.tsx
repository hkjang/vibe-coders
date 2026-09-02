import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SystemHealthPage } from "@/features/system/health/SystemHealthPage";
import { apiClient } from "@/shared/api/client";
import { endpoints, type ApiEndpointBase } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { usePreferences } from "@/shared/stores/preferences";

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    authenticationMode: "session",
    backendVersion: "v0.81.0",
    legacyFallback: true,
    mode: "authenticated",
    user: { scopes: ["admin:read"] },
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

const status = {
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
    free_bytes: 1_048_576,
    total_bytes: 2_097_152,
    used_percent: 50,
  },
} as const;

function mockSystemApi(failFirstRisk = false, mediumRisk = false, partialFailure = false): void {
  let riskAttempts = 0;
  vi.spyOn(apiClient, "request").mockImplementation((async (endpoint: ApiEndpointBase) => {
    if (endpoint.path === endpoints.admin.ops.risk.path) {
      riskAttempts += 1;
      if (failFirstRisk && riskAttempts === 1) {
        throw new AppError("위험 상태를 조회할 수 없습니다.", {
          kind: "http",
          requestId: "req-risk-7",
          status: 503,
        });
      }
      return {
        risk: {
          score: mediumRisk || partialFailure ? 25 : 10,
          tier: mediumRisk || partialFailure ? "medium" : "low",
          factors: partialFailure
            ? [
                {
                  key: "provider_health_unavailable",
                  points: 15,
                  severity: "warning",
                  message: "Provider 상태 데이터를 조회할 수 없습니다.",
                },
              ]
            : [
                {
                  key: mediumRisk ? "disk_low" : "raw_bodies",
                  points: mediumRisk ? 20 : 5,
                  severity: mediumRisk ? "critical" : "info",
                  message: mediumRisk ? "데이터 디스크 사용률이 높습니다." : "Body 원문 로깅을 확인하세요.",
                },
              ],
        },
        status: partialFailure
          ? {
              ...status,
              providers: [],
              partial_failures: [
                {
                  component: "providers",
                  code: "provider_health_unavailable",
                  message: "Provider health data is temporarily unavailable.",
                },
                {
                  component: "fallback",
                  code: "fallback_stats_unavailable",
                  message: "Fallback log statistics are temporarily unavailable.",
                },
              ],
            }
          : mediumRisk
            ? { ...status, disk: { ...status.disk, used_percent: 95 } }
            : status,
      };
    }
    throw new Error(`unexpected request ${endpoint.path}`);
  }) as typeof apiClient.request);
}

function renderPage(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SystemHealthPage />
    </QueryClientProvider>,
  );
}

describe("SystemHealthPage", () => {
  beforeEach(() => {
    usePreferences.setState({ refreshInterval: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders accessible system snapshot details and the Legacy bridge", async () => {
    mockSystemApi();
    renderPage();

    expect(await screen.findByText("openai")).toBeVisible();
    expect(screen.getByText("1 MiB")).toBeVisible();
    expect(screen.getByRole("list", { name: "보안 설정 점검" })).toBeVisible();
    expect(screen.getByRole("table", { name: "Provider 현재 운영 점수" })).toBeVisible();
    expect(screen.getByText("Legacy에서 열기")).toHaveAttribute("href", "/admin#/ops-home");
    expect(
      vi
        .mocked(apiClient.request)
        .mock.calls.some(([endpoint]) => endpoint.path === endpoints.admin.ops.status.path),
    ).toBe(false);
  });

  it("shows a consistent snapshot error and retries the combined request", async () => {
    mockSystemApi(true);
    const user = userEvent.setup();
    renderPage();

    expect((await screen.findAllByText("Request ID: req-risk-7")).length).toBeGreaterThan(0);
    const retry = screen.getAllByRole("button", { name: "System Health snapshot 재시도" }).at(0);
    if (!retry) throw new Error("retry button was not rendered");
    await user.click(retry);

    await waitFor(() => expect(screen.getByText("Body 원문 로깅을 확인하세요.")).toBeVisible());
    expect(screen.queryByText("Request ID: req-risk-7")).not.toBeInTheDocument();
  });

  it("does not report medium risk or a 95 percent disk as healthy", async () => {
    mockSystemApi(false, true);
    renderPage();

    expect(await screen.findByText("데이터 디스크 사용률이 높습니다.")).toBeVisible();
    expect(screen.getAllByText("Degraded").length).toBeGreaterThan(0);
    expect(screen.getByText("Critical")).toBeVisible();
  });

  it("distinguishes unavailable Provider and fallback data from valid empty values", async () => {
    mockSystemApi(false, false, true);
    renderPage();

    expect(await screen.findByText("Provider health data is temporarily unavailable.")).toBeVisible();
    expect(screen.getByText("Fallback log statistics are temporarily unavailable.")).toBeVisible();
    expect(screen.getByText("Unavailable")).toBeVisible();
    expect(screen.queryByText("수집된 Provider 상태가 없습니다.")).not.toBeInTheDocument();
    expect(screen.getAllByText("확인 실패").length).toBeGreaterThanOrEqual(2);
  });

  it("has no automated accessibility violations", async () => {
    mockSystemApi();
    const { container } = renderPage();

    await screen.findByRole("table", { name: "Provider 현재 운영 점수" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
