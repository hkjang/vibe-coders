import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { ModelPage } from "@/features/gateway/models/ModelPage";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type {
  AdminModel,
  AdminModelsResponse,
  ModelQualityResponse,
  ModelUsageTagsResponse,
  PricingResponse,
} from "@/shared/api/schemas";
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

const baseModel = {
  created: 1_700_000_000,
  deprecation: null,
  fetched_at: "2026-09-02T00:00:00Z",
  id: "gpt-5",
  object: "model",
  owned_by: "openai",
  provider: "openai",
  source: "live",
  stale: false,
  virtual: false,
} satisfies AdminModel;

const openAIShared = {
  ...baseModel,
  id: "shared-model",
  source: "agent_route",
  virtual: true,
} satisfies AdminModel;

const openAISharedLive = {
  ...baseModel,
  id: "shared-model",
} satisfies AdminModel;

const anthropicShared = {
  ...baseModel,
  id: "shared-model",
  owned_by: "anthropic",
  provider: "anthropic",
  stale: true,
} satisfies AdminModel;

const retiredModel = {
  ...baseModel,
  deprecation: {
    action: "block",
    id: "dep-old",
    message: "Use gpt-5",
    model_glob: "gpt-old",
    replacement: "gpt-5",
    retired: true,
    sunset_date: "2026-08-01",
    sunset_reached: true,
  },
  id: "gpt-old",
} satisfies AdminModel;

const modelResponse = {
  generated_at: "2026-09-02T00:00:00Z",
  models: [baseModel, openAISharedLive, openAIShared, anthropicShared, retiredModel],
  partial_failures: [],
  providers: [
    {
      fetched_at: "2026-09-02T00:00:00Z",
      model_count: 4,
      provider: "openai",
      source: "live",
      stale: false,
      status: "ok",
    },
    {
      fetched_at: "2026-09-02T00:00:00Z",
      model_count: 1,
      provider: "anthropic",
      source: "live",
      stale: true,
      status: "ok",
    },
  ],
  request_id: "req-model-catalogue",
} satisfies AdminModelsResponse;

const qualityResponse = {
  categories: ["tests", "security"],
  models: [
    {
      categories: { tests: { pass_rate: 0.9, samples: 10 } },
      eval_pass_rate: 0.9,
      eval_samples: 10,
      golden_pass_rate: 0.8,
      golden_samples: 5,
      model: "gpt-5",
      quality_score: 91,
      requests: 120,
      success_rate: 0.98,
    },
    {
      categories: {},
      eval_pass_rate: 0.8,
      eval_samples: 8,
      golden_pass_rate: 0.75,
      golden_samples: 4,
      model: "shared-model",
      quality_score: 82,
      requests: 80,
      success_rate: 0.95,
    },
  ],
  since: "2026-09-01T00:00:00Z",
} satisfies ModelQualityResponse;

const pricingResponse = {
  effective: {
    "gpt-5": {
      cached_input_krw_per_1m: 100,
      input_krw_per_1m: 1_000,
      output_krw_per_1m: 2_000,
    },
    "shared-model": {
      cached_input_krw_per_1m: 80,
      input_krw_per_1m: 800,
      output_krw_per_1m: 1_600,
    },
  },
  versions: [],
} satisfies PricingResponse;

const tagsResponse = {
  tags: [
    {
      avoid_for: "regulated data",
      good_for: "coding, analysis",
      model: "gpt-5",
      risk_note: "Review generated code",
      updated_at: "2026-09-02T00:00:00Z",
      updated_by: "admin",
    },
  ],
} satisfies ModelUsageTagsResponse;

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderPage(
  initialEntry = "/gateway/models",
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/gateway/models"
            element={
              <>
                <ModelPage />
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
  models?: AdminModelsResponse;
  modelError?: AppError;
  pricingError?: AppError;
  qualityError?: AppError;
  tagsError?: AppError;
}

function mockApi({
  models = modelResponse,
  modelError,
  pricingError,
  qualityError,
  tagsError,
}: ApiScenario = {}) {
  return vi.spyOn(apiClient, "request").mockImplementation(async (endpoint) => {
    if (endpoint.path === endpoints.admin.models.list.path) {
      if (modelError) throw modelError;
      return models as never;
    }
    if (endpoint.path === endpoints.admin.models.quality.path) {
      if (qualityError) throw qualityError;
      return qualityResponse as never;
    }
    if (endpoint.path === endpoints.admin.models.pricing.path) {
      if (pricingError) throw pricingError;
      return pricingResponse as never;
    }
    if (endpoint.path === endpoints.admin.models.tags.path) {
      if (tagsError) throw tagsError;
      return tagsResponse as never;
    }
    throw new Error(`Unexpected endpoint: ${endpoint.path}`);
  });
}

describe("ModelPage", () => {
  beforeEach(() => {
    authRuntime.legacyFallback = true;
    authRuntime.scopes = ["admin:read"];
    usePreferences.setState({ refreshInterval: 0 });
    vi.restoreAllMocks();
  });

  it("filters through URL state and requests all read-only enrichments with the selected range", async () => {
    const user = userEvent.setup();
    const request = mockApi();
    renderPage("/gateway/models?q=shared&provider=anthropic&status=stale&range=7d");

    const link = await screen.findByRole("link", { name: "shared-model" });
    const table = screen.getByRole("table", { name: "Provider별 Model 상태, 품질과 가격" });
    expect(link).toBeVisible();
    expect(within(table).queryByRole("link", { name: "gpt-5" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "7일" })).toHaveAttribute("aria-pressed", "true");

    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    expect(request).toHaveBeenCalledWith(
      endpoints.admin.models.quality,
      expect.objectContaining({ query: { window: "7d" }, routeId: "gateway.models" }),
    );

    await user.selectOptions(screen.getByLabelText("상태"), "all");
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/gateway/models?q=shared&provider=anthropic&range=7d",
    );
  });

  it("keeps duplicate provider/model sources distinct and restores the exact trigger after Escape", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    const links = await screen.findAllByRole("link", { name: "shared-model" });
    expect(links).toHaveLength(3);
    const agentRouteRow = links
      .map((link) => link.closest("tr"))
      .find((row) => row && within(row).queryAllByText("agent route").length > 0);
    if (!agentRouteRow) throw new Error("agent-route duplicate row not found");
    const trigger = within(agentRouteRow).getByRole("link", { name: "shared-model" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "shared-model" });
    expect(within(dialog).getAllByText("openai").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("agent route")).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent("provider=openai");
    expect(screen.getByTestId("location")).toHaveTextContent("model=shared-model");
    expect(screen.getByTestId("location")).toHaveTextContent("source=agent_route");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "shared-model" })).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("location")).not.toHaveTextContent("model=");
    expect(screen.getByTestId("location")).not.toHaveTextContent("source=");
    expect(screen.getByTestId("location")).toHaveTextContent("provider=openai");
    const restoredTrigger = screen
      .getAllByRole("link", { name: "shared-model" })
      .find((link) => link.dataset.modelTrigger?.includes("agent_route"));
    if (!restoredTrigger) throw new Error("restored agent-route trigger not found");
    await waitFor(() => expect(restoredTrigger).toHaveFocus());
  });

  it("keeps rows usable on enrichment errors and exposes exact request IDs", async () => {
    const user = userEvent.setup();
    const request = mockApi({
      pricingError: new AppError("가격 조회 실패", {
        kind: "http",
        requestId: "req-pricing-503",
        retryable: true,
        status: 503,
      }),
      qualityError: new AppError("품질 조회 실패", {
        kind: "http",
        requestId: "req-quality-503",
        retryable: true,
        status: 503,
      }),
      tagsError: new AppError("사용 지침 조회 실패", {
        kind: "http",
        requestId: "req-tags-503",
        retryable: true,
        status: 503,
      }),
    });
    renderPage("/gateway/models?provider=openai&model=gpt-5&source=live");

    const dialog = await screen.findByRole("dialog", { name: "gpt-5" });
    expect(await within(dialog).findByText("Request ID: req-pricing-503")).toBeVisible();
    expect(within(dialog).getByText("Request ID: req-quality-503")).toBeVisible();
    expect(within(dialog).getByText("Request ID: req-tags-503")).toBeVisible();

    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    await user.click(within(dialog).getByRole("button", { name: "Model 가격 상세 재시도" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(5));
  });

  it("manually refreshes every catalogue source", async () => {
    const user = userEvent.setup();
    const request = mockApi();
    renderPage();

    await screen.findByRole("link", { name: "gpt-5" });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    await user.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(8));
  });

  it("does not present previous-range quality as the newly selected range", async () => {
    const user = userEvent.setup();
    let qualityCalls = 0;
    let resolveNextQuality: ((value: ModelQualityResponse) => void) | undefined;
    const nextQuality = new Promise<ModelQualityResponse>((resolve) => {
      resolveNextQuality = resolve;
    });
    vi.spyOn(apiClient, "request").mockImplementation(async (endpoint) => {
      if (endpoint.path === endpoints.admin.models.list.path) return modelResponse as never;
      if (endpoint.path === endpoints.admin.models.quality.path) {
        qualityCalls += 1;
        return (qualityCalls === 1 ? qualityResponse : nextQuality) as never;
      }
      if (endpoint.path === endpoints.admin.models.pricing.path) return pricingResponse as never;
      if (endpoint.path === endpoints.admin.models.tags.path) return tagsResponse as never;
      throw new Error(`Unexpected endpoint: ${endpoint.path}`);
    });
    renderPage("/gateway/models?provider=openai&model=gpt-5&source=live");

    const dialog = await screen.findByRole("dialog", { name: "gpt-5" });
    expect(await within(dialog).findByText("91점")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "gpt-5" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "7일" }));
    await user.click(screen.getByRole("link", { name: "gpt-5" }));
    const loadingDialog = await screen.findByRole("dialog", { name: "gpt-5" });
    expect(await within(loadingDialog).findByText("Model 품질 정보를 불러오는 중입니다.")).toBeVisible();
    expect(within(loadingDialog).queryByText("91점")).not.toBeInTheDocument();

    resolveNextQuality?.({
      ...qualityResponse,
      models: [
        {
          ...(qualityResponse.models[0] as ModelQualityResponse["models"][number]),
          quality_score: 77,
        },
      ],
    });
    expect(await within(loadingDialog).findByText("77점")).toBeVisible();
  });

  it("keeps enrichment last-known-good data visible inside the modal", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["admin", "models", "quality", "24h"], qualityResponse);
    client.setQueryData(["admin", "pricing"], pricingResponse);
    client.setQueryData(["admin", "model-tags"], tagsResponse);
    mockApi({
      pricingError: new AppError("가격 갱신 실패", {
        kind: "network",
        requestId: "req-pricing-lkg",
        retryable: true,
      }),
      qualityError: new AppError("품질 갱신 실패", {
        kind: "network",
        requestId: "req-quality-lkg",
        retryable: true,
      }),
      tagsError: new AppError("사용 지침 갱신 실패", {
        kind: "network",
        requestId: "req-tags-lkg",
        retryable: true,
      }),
    });
    renderPage("/gateway/models?provider=openai&model=gpt-5&source=live", client);

    const dialog = await screen.findByRole("dialog", { name: "gpt-5" });
    expect(await within(dialog).findByText("Request ID: req-quality-lkg")).toBeVisible();
    expect(within(dialog).getByText("Request ID: req-pricing-lkg")).toBeVisible();
    expect(within(dialog).getByText("Request ID: req-tags-lkg")).toBeVisible();
    expect(within(dialog).getAllByText(/마지막 정상 데이터를 표시합니다/)).toHaveLength(3);
    expect(within(dialog).getByText("91점")).toBeVisible();
    expect(within(dialog).getByText("₩1,000")).toBeVisible();
    expect(within(dialog).getByText("coding, analysis")).toBeVisible();
  });

  it("shows successful partial failures with the catalogue request ID", async () => {
    mockApi({
      models: {
        ...modelResponse,
        partial_failures: [
          {
            code: "provider_models_unavailable",
            message: "Provider model catalog is unavailable.",
            provider: "anthropic",
          },
        ],
        request_id: "req-partial-models",
      },
    });
    renderPage();

    expect(await screen.findByText("Request ID: req-partial-models")).toBeVisible();
    expect(screen.getByText(/Provider model catalog is unavailable/)).toBeVisible();
    expect(screen.getByRole("table", { name: "Provider별 Model 상태, 품질과 가격" })).toBeVisible();
  });

  it("shows last-known-good rows after catalogue refresh failure", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["admin", "models"], modelResponse, { updatedAt: Date.now() - 30_000 });
    mockApi({
      modelError: new AppError("Model 목록 갱신 실패", {
        kind: "network",
        requestId: "req-model-lkg",
        retryable: true,
      }),
    });
    renderPage("/gateway/models", client);

    const table = await screen.findByRole("table", { name: "Provider별 Model 상태, 품질과 가격" });
    expect(within(table).getByRole("link", { name: "gpt-5" })).toBeVisible();
    expect(await screen.findByText(/Model 목록 갱신에 실패해 마지막 정상 데이터를 표시합니다/)).toBeVisible();
    expect(screen.getByText("Request ID: req-model-lkg")).toBeVisible();
  });

  it("renders a terminal error when no catalogue data has succeeded", async () => {
    mockApi({
      modelError: new AppError("Model 목록 조회 실패", {
        kind: "http",
        requestId: "req-model-terminal",
        retryable: true,
        status: 500,
      }),
    });
    renderPage();

    expect(await screen.findByText("Request ID: req-model-terminal")).toBeVisible();
    expect(within(screen.getByLabelText("Model 요약")).getAllByText("—")).toHaveLength(4);
    expect(screen.getByText("마지막 정상 Model 목록이 없습니다.")).toBeVisible();
    expect(
      screen.queryByRole("table", { name: "Provider별 Model 상태, 품질과 가격" }),
    ).not.toBeInTheDocument();
  });

  it("distinguishes an actual empty catalogue from an unavailable one", async () => {
    mockApi({ models: { ...modelResponse, models: [], providers: [] } });
    renderPage();

    expect(
      await screen.findByText("조회 가능한 Model이 없습니다. Provider 연결과 Model route를 확인하세요."),
    ).toBeVisible();
    expect(within(screen.getByLabelText("Model 요약")).getAllByText("0")).toHaveLength(4);
  });

  it("paginates client-side while preserving the page in the URL", async () => {
    const user = userEvent.setup();
    const manyModels = Array.from({ length: 11 }, (_, index) => ({
      ...baseModel,
      id: `model-${String(index + 1).padStart(2, "0")}`,
    }));
    mockApi({ models: { ...modelResponse, models: manyModels } });
    renderPage();

    expect(await screen.findByText("1 / 2")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(screen.getByTestId("location")).toHaveTextContent("?page=2");
    expect(await screen.findByRole("link", { name: "model-11" })).toBeVisible();
  });

  it("hides Legacy links when fallback is unavailable", async () => {
    authRuntime.legacyFallback = false;
    mockApi();
    renderPage();

    await screen.findByRole("table", { name: "Provider별 Model 상태, 품질과 가격" });
    expect(screen.queryByRole("link", { name: /Legacy/ })).not.toBeInTheDocument();
  });

  it("has no automated accessibility violations", async () => {
    mockApi();
    const { container } = renderPage();

    await screen.findByRole("table", { name: "Provider별 Model 상태, 품질과 가격" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
