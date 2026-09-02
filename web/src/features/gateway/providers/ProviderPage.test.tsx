import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";

import { ProviderPage } from "@/features/gateway/providers/ProviderPage";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { Provider, ProviderList, ProviderSLOResponse, RoutingHealth } from "@/shared/api/schemas";
import { usePreferences } from "@/shared/stores/preferences";

const authRuntime = vi.hoisted(() => ({ legacyFallback: true, scopes: ["admin:read"] }));

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    authenticationMode: "session",
    legacyFallback: authRuntime.legacyFallback,
    mode: "authenticated",
    user: {
      id: "admin-1",
      role: "admin",
      roles: ["admin"],
      scopes: authRuntime.scopes,
    },
  }),
}));

const openAIProvider = {
  name: "openai",
  base_url: "https://api.openai.example/v1",
  api_key_configured: true,
  timeout_ms: 30_000,
  enabled: true,
  model_patterns: "gpt-*",
  failover_group: "premium",
  priority: 10,
  created_at: "2026-08-01T09:00:00Z",
} satisfies Provider;

const anthropicProvider = {
  ...openAIProvider,
  name: "anthropic",
  base_url: "https://api.anthropic.example/v1",
  model_patterns: "claude-*",
  failover_group: "balanced",
  priority: 20,
} satisfies Provider;

const disabledProvider = {
  ...openAIProvider,
  name: "local-disabled",
  base_url: "http://local-model:8080/v1",
  api_key_configured: false,
  enabled: false,
  model_patterns: "local/*",
  failover_group: "",
  priority: 100,
} satisfies Provider;

const providerList = {
  providers: [openAIProvider, anthropicProvider, disabledProvider],
} satisfies ProviderList;

const metric = (target: number, actual: number, breached = false) => ({
  target,
  actual,
  breached,
  enforced: target > 0,
});

const sloResponse = {
  slos: [
    {
      provider: "openai",
      availability_target: 0.99,
      p95_latency_target_ms: 700,
      error_rate_target: 0.02,
      fallback_rate_target: 0.05,
      enabled: true,
      note: "production objective",
      updated_at: "2026-09-01T08:00:00Z",
    },
    {
      provider: "anthropic",
      availability_target: 0.99,
      p95_latency_target_ms: 900,
      error_rate_target: 0.02,
      fallback_rate_target: 0.05,
      enabled: true,
      note: "",
      updated_at: "2026-09-01T08:00:00Z",
    },
  ],
  evaluations: [
    {
      provider: "openai",
      requests: 120,
      enabled: true,
      breached: true,
      metrics: {
        availability: metric(0.99, 0.97, true),
        p95_latency_ms: metric(700, 810, true),
        error_rate: metric(0.02, 0.03, true),
        fallback_rate: metric(0.05, 0.04),
      },
    },
    {
      provider: "anthropic",
      requests: 80,
      enabled: true,
      breached: false,
      metrics: {
        availability: metric(0.99, 0.995),
        p95_latency_ms: metric(900, 620),
        error_rate: metric(0.02, 0.005),
        fallback_rate: metric(0.05, 0.01),
      },
    },
  ],
  since: "2026-09-01T00:00:00Z",
} satisfies ProviderSLOResponse;

const routingHealth = {
  since: "2026-09-01T00:00:00Z",
  until: "2026-09-02T00:00:00Z",
  threshold: 70,
  providers: [
    {
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
    },
    {
      provider: "anthropic",
      score: 94,
      requests: 80,
      average_latency_ms: 310,
      p95_latency_ms: 620,
      timeouts: 0,
      rate_429: 0,
      rate_5xx: 0,
      fallbacks: 1,
      fallback_rate: 0.0125,
    },
  ],
  ranking: [],
  degraded: [
    {
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
    },
  ],
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
} satisfies RoutingHealth;

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
      <button type="button" onClick={() => void navigate("/gateway/providers?q=authToken%3Dprivate")}>
        Unsafe search navigation
      </button>
    </>
  );
}

function renderPage(
  initialEntry = "/gateway/providers",
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/gateway/providers"
            element={
              <>
                <ProviderPage />
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
  providerData?: ProviderList;
  providerError?: AppError;
  routingData?: RoutingHealth;
  routingError?: AppError;
  sloData?: ProviderSLOResponse;
  sloError?: AppError;
}

function mockApi({
  providerData = providerList,
  providerError,
  routingData = routingHealth,
  routingError,
  sloData = sloResponse,
  sloError,
}: ApiScenario = {}) {
  return vi.spyOn(apiClient, "request").mockImplementation(async (endpoint) => {
    if (endpoint.path === endpoints.admin.providers.list.path) {
      if (providerError) throw providerError;
      return providerData as never;
    }
    if (endpoint.path === endpoints.admin.providers.slo.path) {
      if (sloError) throw sloError;
      return sloData as never;
    }
    if (endpoint.path === endpoints.admin.routing.health.path) {
      if (routingError) throw routingError;
      return routingData as never;
    }
    throw new Error(`Unexpected endpoint: ${endpoint.path}`);
  });
}

describe("ProviderPage", () => {
  beforeEach(() => {
    authRuntime.legacyFallback = true;
    authRuntime.scopes = ["admin:read"];
    usePreferences.setState({ refreshInterval: 0 });
    vi.restoreAllMocks();
  });

  it("filters through URL state and never requests routing health without routing:read", async () => {
    const user = userEvent.setup();
    const request = mockApi();
    renderPage("/gateway/providers?q=anth&status=enabled&range=7d");

    const table = screen.getByRole("table", { name: "Provider 연결 설정과 운영 상태" });
    await screen.findByRole("link", { name: "anthropic" });
    expect(within(table).getByRole("link", { name: "anthropic" })).toBeVisible();
    expect(within(table).queryByRole("link", { name: "openai" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "7일" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/SLO 평가만 표시합니다/)).toBeVisible();

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.some(([endpoint]) => endpoint.path === "/admin/routing/health")).toBe(false);

    await user.selectOptions(screen.getByLabelText("상태"), "degraded");
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/gateway/providers?q=anth&status=degraded&range=7d",
    );
  });

  it("requests routing enrichment with the selected range only when permitted", async () => {
    authRuntime.scopes = ["admin:read", "routing:read"];
    const request = mockApi();
    renderPage("/gateway/providers?range=30d");

    const table = screen.getByRole("table", { name: "Provider 연결 설정과 운영 상태" });
    await within(table).findByText("810 ms");
    expect(within(table).getByText("810 ms")).toBeVisible();
    expect(screen.queryByText(/라우팅 상세 신호는 제한/)).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(
      endpoints.admin.routing.health,
      expect.objectContaining({
        query: { threshold: 70, window: "30d" },
        routeId: "gateway.providers",
      }),
    );
  });

  it("does not mix the previous range into a newly selected range while enrichment is pending", async () => {
    authRuntime.scopes = ["admin:read", "routing:read"];
    let resolveSevenDays: ((value: RoutingHealth) => void) | undefined;
    const sevenDays = new Promise<RoutingHealth>((resolve) => {
      resolveSevenDays = resolve;
    });
    vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, options) => {
      if (endpoint.path === endpoints.admin.providers.list.path) return providerList as never;
      if (endpoint.path === endpoints.admin.providers.slo.path) return sloResponse as never;
      if (endpoint.path === endpoints.admin.routing.health.path) {
        const window = (options as { query?: { window?: string } }).query?.window;
        if (window === "7d") return (await sevenDays) as never;
        return routingHealth as never;
      }
      throw new Error(`Unexpected endpoint: ${endpoint.path}`);
    });
    const user = userEvent.setup();
    renderPage("/gateway/providers?range=24h");

    const table = screen.getByRole("table", { name: "Provider 연결 설정과 운영 상태" });
    expect(await within(table).findByText("810 ms")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "7일" }));

    expect(await within(table).findAllByText("Checking")).not.toHaveLength(0);
    expect(within(table).queryByText("810 ms")).not.toBeInTheDocument();
    expect(screen.getByText(/선택 기간의 Provider 운영 상태를 확인하는 중/)).toBeVisible();
    const summary = screen.getByRole("region", { name: "Provider 요약" });
    expect(within(summary).getAllByText("—")).toHaveLength(2);

    resolveSevenDays?.(routingHealth);
    expect(await within(table).findByText("810 ms")).toBeVisible();
  });

  it("shows unavailable summary values instead of real zeroes during initial loading", async () => {
    let resolveProviders: ((value: ProviderList) => void) | undefined;
    let resolveSLO: ((value: ProviderSLOResponse) => void) | undefined;
    const providerResponse = new Promise<ProviderList>((resolve) => {
      resolveProviders = resolve;
    });
    const sloResult = new Promise<ProviderSLOResponse>((resolve) => {
      resolveSLO = resolve;
    });
    vi.spyOn(apiClient, "request").mockImplementation(async (endpoint) => {
      if (endpoint.path === endpoints.admin.providers.list.path) return (await providerResponse) as never;
      if (endpoint.path === endpoints.admin.providers.slo.path) return (await sloResult) as never;
      throw new Error(`Unexpected endpoint: ${endpoint.path}`);
    });
    renderPage();

    const summary = screen.getByRole("region", { name: "Provider 요약" });
    expect(within(summary).getAllByText("—")).toHaveLength(4);
    expect(within(summary).queryByText("0")).not.toBeInTheDocument();

    resolveProviders?.(providerList);
    resolveSLO?.(sloResponse);
    expect(await screen.findByRole("link", { name: "openai" })).toBeVisible();
  });

  it("keeps the provider list usable when SLO enrichment fails and exposes the exact request ID", async () => {
    const user = userEvent.setup();
    mockApi({
      sloError: new AppError("SLO 집계를 불러오지 못했습니다.", {
        kind: "http",
        requestId: "req-provider-slo-503",
        retryable: true,
        status: 503,
      }),
    });
    renderPage();

    const table = screen.getByRole("table", { name: "Provider 연결 설정과 운영 상태" });
    await screen.findByRole("link", { name: "openai" });
    expect(within(table).getByRole("link", { name: "openai" })).toBeVisible();
    expect(screen.getByText("Request ID: req-provider-slo-503")).toBeVisible();
    expect(screen.getByText(/Provider SLO 조회에 실패했습니다/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Provider SLO 재시도" }));
    expect(screen.getByText("Request ID: req-provider-slo-503")).toBeVisible();
  });

  it("shows last-known-good rows after a provider refresh failure", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["admin", "providers"], providerList, { updatedAt: Date.now() - 30_000 });
    mockApi({
      providerError: new AppError("Provider 목록 갱신 실패", {
        kind: "network",
        requestId: "req-provider-lkg",
        retryable: true,
      }),
    });
    renderPage("/gateway/providers", client);

    const table = await screen.findByRole("table", { name: "Provider 연결 설정과 운영 상태" });
    expect(within(table).getByRole("link", { name: "openai" })).toBeVisible();
    expect(
      await screen.findByText(/Provider 목록 갱신에 실패해 마지막 정상 데이터를 표시합니다/),
    ).toBeVisible();
    expect(screen.getByText("Request ID: req-provider-lkg")).toBeVisible();
  });

  it("shows source-specific SLO and routing failures inside a deep-linked dialog", async () => {
    authRuntime.scopes = ["admin:read", "routing:read"];
    mockApi({
      sloError: new AppError("SLO unavailable", {
        kind: "http",
        requestId: "req-dialog-slo",
        status: 503,
      }),
      routingError: new AppError("Routing unavailable", {
        kind: "http",
        requestId: "req-dialog-routing",
        status: 503,
      }),
    });
    renderPage("/gateway/providers?provider=openai");

    const dialog = await screen.findByRole("dialog", { name: "openai" });
    expect(await within(dialog).findByText(/Provider SLO 조회에 실패했습니다/)).toBeVisible();
    expect(within(dialog).getByText("Request ID: req-dialog-slo")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Provider SLO 재시도" })).toBeVisible();
    expect(within(dialog).getByText(/Provider 라우팅 상태 조회에 실패했습니다/)).toBeVisible();
    expect(within(dialog).getByText("Request ID: req-dialog-routing")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Provider 라우팅 상태 재시도" })).toBeVisible();
    expect(within(dialog).queryByText(/SLO가 설정되지 않았습니다/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/라우팅 상태 데이터가 없습니다/)).not.toBeInTheDocument();
  });

  it("shows provider last-known-good and request ID inside the dialog", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["admin", "providers"], providerList, { updatedAt: Date.now() - 30_000 });
    mockApi({
      providerError: new AppError("Provider refresh failed", {
        kind: "network",
        requestId: "req-dialog-provider-lkg",
      }),
    });
    renderPage("/gateway/providers?provider=openai", client);

    const dialog = await screen.findByRole("dialog", { name: "openai" });
    expect(
      await within(dialog).findByText(/Provider 설정 갱신에 실패해 마지막 정상 데이터를 표시합니다/),
    ).toBeVisible();
    expect(within(dialog).getByText("Request ID: req-dialog-provider-lkg")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Provider 설정 재시도" })).toBeVisible();
    expect(within(dialog).getByText("https://api.openai.example/v1")).toBeVisible();
  });

  it("removes credential searches from deep links and never writes submitted secrets to the URL", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["admin", "providers"], providerList);
    mockApi();
    renderPage("/gateway/providers?q=api_key%3Dprivate&status=enabled", client);

    const providerLink = screen.getByRole("link", { name: "openai" });
    expect(providerLink.getAttribute("href")).not.toContain("private");
    expect(screen.getByTestId("location")).toHaveTextContent("?status=enabled");
    expect(screen.getByTestId("location")).not.toHaveTextContent("private");
    expect(screen.getByRole("alert")).toHaveTextContent("인증정보로 보이는 검색어");

    const input = screen.getByRole("textbox", { name: "Provider 검색" });
    await user.clear(input);
    await user.type(input, "https://operator:password@provider.example/v1");
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("location")).not.toHaveTextContent("operator");
    expect(screen.getByTestId("location")).not.toHaveTextContent("password");
  });

  it("keeps the rejection notice when unsafe q arrives after the page has mounted", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await screen.findByRole("link", { name: "openai" });

    await user.click(screen.getByRole("button", { name: "Unsafe search navigation" }));
    await waitFor(() => expect(screen.getByTestId("location")).not.toHaveTextContent("private"));
    expect(screen.getByRole("alert")).toHaveTextContent("인증정보로 보이는 검색어");
    expect(screen.getByRole("textbox", { name: "Provider 검색" })).toHaveAttribute("aria-invalid", "true");
  });

  it("deep-links provider details, closes with Escape, and restores trigger focus", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    const trigger = await screen.findByRole("link", { name: "openai" });
    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: "openai" })).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent("provider=openai");
    expect(screen.getByText("production objective")).toBeVisible();
    expect(screen.getByText(/routing:read 권한이 없어/)).toBeVisible();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "openai" })).not.toBeInTheDocument());
    expect(screen.getByTestId("location")).not.toHaveTextContent("provider=");
    await waitFor(() => expect(screen.getByRole("link", { name: "openai" })).toHaveFocus());
  });

  it("never exposes or misattributes distinct unsafe legacy provider names", async () => {
    authRuntime.scopes = ["admin:read", "routing:read"];
    const user = userEvent.setup();
    const firstName = "sk-ant-first-private-value";
    const secondName = "Bearer second-private-value";
    const unsafeProviders = [firstName, secondName].map((name, index) => ({
      ...openAIProvider,
      name,
      base_url: "https://legacy.example/v1",
      model_patterns: "legacy-*",
      priority: 30 + index,
    }));
    const [baseScore] = routingHealth.providers;
    const [firstSlo, secondSlo] = sloResponse.slos;
    const [firstEvaluation, secondEvaluation] = sloResponse.evaluations;
    if (!baseScore || !firstSlo || !secondSlo || !firstEvaluation || !secondEvaluation) {
      throw new Error("Provider fixtures are incomplete");
    }
    const redactedScore = {
      ...baseScore,
      provider: "[provider-name-omitted]",
    };
    mockApi({
      providerData: { providers: unsafeProviders },
      routingData: {
        ...routingHealth,
        providers: [redactedScore, { ...redactedScore }],
        degraded: [redactedScore, { ...redactedScore }],
      },
      sloData: {
        ...sloResponse,
        slos: [
          { ...firstSlo, provider: firstName },
          { ...secondSlo, provider: secondName },
        ],
        evaluations: [
          { ...firstEvaluation, provider: firstName, breached: true },
          { ...secondEvaluation, provider: secondName, breached: true },
        ],
      },
    });
    const { container } = renderPage();

    const table = await screen.findByRole("table", { name: "Provider 연결 설정과 운영 상태" });
    const redactedLinks = await within(table).findAllByRole("link", { name: /Provider 이름 비공개/ });
    expect(redactedLinks).toHaveLength(2);
    expect(new Set(redactedLinks.map((link) => link.textContent)).size).toBe(2);
    expect(within(table).getAllByText("Unknown")).toHaveLength(2);
    expect(container.outerHTML).not.toContain(firstName);
    expect(container.outerHTML).not.toContain(secondName);
    for (const link of redactedLinks) {
      expect(link.getAttribute("href")).toContain("provider=redacted-provider-");
      expect(link.getAttribute("href")).not.toContain("private-value");
    }

    const firstRedactedLink = redactedLinks[0];
    if (!firstRedactedLink) throw new Error("Expected a redacted Provider link");
    await user.click(firstRedactedLink);
    const dialog = await screen.findByRole("dialog", { name: /Provider 이름 비공개/ });
    expect(within(dialog).getByText(/운영 상태 연결을 생략했습니다/)).toBeVisible();
    expect(within(dialog).getByText("이름 보호를 위해 SLO 연결을 생략했습니다.")).toBeVisible();
    expect(within(dialog).getByText("이름 보호를 위해 라우팅 상태 연결을 생략했습니다.")).toBeVisible();
    expect(within(dialog).queryByText(/SLO가 설정되지 않았습니다/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/라우팅 상태 데이터가 없습니다/)).not.toBeInTheDocument();
    expect(dialog.outerHTML).not.toContain(firstName);
    expect(dialog.outerHTML).not.toContain(secondName);
    expect(screen.getByTestId("location")).not.toHaveTextContent("private-value");

    await user.keyboard("{Escape}");
    const input = screen.getByRole("textbox", { name: "Provider 검색" });
    await user.type(input, "first-private");
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(await screen.findByText("검색 및 필터 조건에 맞는 Provider가 없습니다.")).toBeVisible();
  });

  it("paginates client-side while preserving the page in the URL", async () => {
    const user = userEvent.setup();
    const manyProviders = Array.from({ length: 11 }, (_, index) => ({
      ...openAIProvider,
      name: `provider-${String(index + 1).padStart(2, "0")}`,
      priority: 100,
    }));
    vi.spyOn(apiClient, "request").mockImplementation(async (endpoint) => {
      if (endpoint.path === endpoints.admin.providers.list.path) {
        return { providers: manyProviders } as never;
      }
      if (endpoint.path === endpoints.admin.providers.slo.path) {
        return { slos: [], evaluations: [], since: "2026-09-01T00:00:00Z" } as never;
      }
      throw new Error(`Unexpected endpoint: ${endpoint.path}`);
    });
    renderPage();

    expect(await screen.findByText("1 / 2")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(screen.getByTestId("location")).toHaveTextContent("?page=2");
    expect(await screen.findByRole("link", { name: "provider-11" })).toBeVisible();
  });

  it("has no automated accessibility violations", async () => {
    authRuntime.scopes = ["admin:read", "routing:read"];
    mockApi();
    const { container } = renderPage();

    await screen.findByRole("table", { name: "Provider 연결 설정과 운영 상태" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
