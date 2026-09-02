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

const providerRef = (seed: string): string =>
  `prv_${[...seed]
    .map((character) => character.charCodeAt(0).toString(36))
    .join("")
    .padEnd(43, "x")
    .slice(0, 43)}`;

const baseModel = {
  created: 1_700_000_000,
  deprecation: null,
  fetched_at: "2026-09-02T00:00:00Z",
  id: "gpt-5",
  object: "model",
  owned_by: "openai",
  provider: "openai",
  provider_ref: providerRef("openai"),
  shadowed: false,
  shadowed_by: "",
  source: "live",
  stale: false,
  virtual: false,
} satisfies AdminModel;

const openAIShared = {
  ...baseModel,
  id: "shared-model",
  provider_ref: providerRef("agent-route-openai"),
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
  provider_ref: providerRef("anthropic"),
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

const shadowedModel = {
  ...baseModel,
  id: "gpt-shadowed",
  shadowed: true,
  shadowed_by: "agent-route-priority",
  stale: true,
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
      provider_ref: providerRef("openai"),
      source: "live",
      stale: false,
      status: "ok",
    },
    {
      fetched_at: "2026-09-02T00:00:00Z",
      model_count: 1,
      provider: "anthropic",
      provider_ref: providerRef("anthropic"),
      source: "live",
      stale: true,
      status: "ok",
    },
  ],
  request_id: "req-model-catalogue",
} satisfies AdminModelsResponse;

const qualityResponse: ModelQualityResponse = {
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
};

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
    renderPage(`/gateway/models?q=shared&provider=${providerRef("anthropic")}&status=stale&range=7d`);

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
      `/gateway/models?q=shared&provider=${providerRef("anthropic")}&range=7d`,
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
    expect(within(dialog).getAllByText(/openai/).length).toBeGreaterThan(0);
    expect(within(dialog).getByText("agent route")).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent(
      `model_provider=${providerRef("agent-route-openai")}`,
    );
    expect(screen.getByTestId("location")).toHaveTextContent("model=shared-model");
    expect(screen.getByTestId("location")).toHaveTextContent("source=agent_route");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "shared-model" })).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/gateway/models");
    const restoredTrigger = screen
      .getAllByRole("link", { name: "shared-model" })
      .find((link) => link.dataset.modelTrigger?.includes("agent_route"));
    if (!restoredTrigger) throw new Error("restored agent-route trigger not found");
    await waitFor(() => expect(restoredTrigger).toHaveFocus());
  });

  it("deep-links, filters, and restores focus for duplicate masked Providers by provider_ref", async () => {
    const user = userEvent.setup();
    const firstRef = `prv_${"A".repeat(43)}`;
    const secondRef = `prv_${"B".repeat(43)}`;
    const maskedModel = {
      ...baseModel,
      id: "masked-shared",
      owned_by: "[provider-name-omitted]",
      provider: "[provider-name-omitted]",
      provider_ref: firstRef,
    } satisfies AdminModel;
    mockApi({
      models: {
        generated_at: modelResponse.generated_at,
        models: [maskedModel, { ...maskedModel, provider_ref: secondRef }],
        partial_failures: [],
        providers: [
          {
            model_count: 1,
            provider: "[provider-name-omitted]",
            provider_ref: firstRef,
            source: "live",
            stale: false,
            status: "ok",
          },
          {
            model_count: 1,
            provider: "[provider-name-omitted]",
            provider_ref: secondRef,
            source: "live",
            stale: false,
            status: "ok",
          },
        ],
        request_id: "req-masked-shared",
      },
    });
    renderPage();

    const table = await screen.findByRole("table", { name: "Provider별 Model 상태, 품질과 가격" });
    const trigger = (await within(table).findAllByRole("link", { name: "masked-shared" })).find((link) =>
      link.getAttribute("href")?.includes(secondRef),
    );
    if (!trigger) throw new Error("Second masked Provider row not found");
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "masked-shared" });
    expect(within(dialog).getAllByText(/BBBBBBBB/).length).toBeGreaterThan(0);
    expect(screen.getByTestId("location")).toHaveTextContent(`model_provider=${secondRef}`);
    await user.keyboard("{Escape}");
    const restoredTrigger = screen
      .getAllByRole("link", { name: "masked-shared" })
      .find((link) => link.dataset.modelTrigger?.includes(secondRef));
    if (!restoredTrigger) throw new Error("Restored masked Provider trigger not found");
    await waitFor(() => expect(restoredTrigger).toHaveFocus());

    await user.selectOptions(screen.getByLabelText("Provider"), secondRef);
    expect(within(table).getAllByRole("link", { name: "masked-shared" })).toHaveLength(1);
    expect(screen.getByTestId("location")).toHaveTextContent(`provider=${secondRef}`);
  });

  it("asks for an exact Provider and source when a model deep link is ambiguous", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage("/gateway/models?model=shared-model");

    const dialog = await screen.findByRole("dialog", { name: "shared-model" });
    expect(await within(dialog).findByText("Provider와 source를 선택해 주세요.")).toBeVisible();
    expect(within(dialog).queryByText("Model을 찾을 수 없습니다.")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("link", { name: /openai .* agent route/ }));

    expect(await within(dialog).findByText("Virtual")).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent(
      `model_provider=${providerRef("agent-route-openai")}`,
    );
    expect(screen.getByTestId("location")).toHaveTextContent("source=agent_route");
  });

  it("shows the required shadow status and prioritizing Agent Route in the detail dialog", async () => {
    const user = userEvent.setup();
    mockApi({ models: { ...modelResponse, models: [...modelResponse.models, shadowedModel] } });
    renderPage(`/gateway/models?model_provider=${providerRef("openai")}&model=gpt-shadowed&source=live`);

    const dialog = await screen.findByRole("dialog", { name: "gpt-shadowed" });
    expect(await within(dialog).findByText("Shadowed")).toBeVisible();
    expect(
      within(dialog).getByText("Agent Route “agent-route-priority”가 동일 Model ID를 우선 처리합니다."),
    ).toBeVisible();
    expect(within(dialog).getByText("마지막 정상 카탈로그")).toBeVisible();
    expect(within(dialog).getByText(/마지막 정상 카탈로그 데이터입니다\. Fetched/)).toBeVisible();

    await user.keyboard("{Escape}");
    const row = screen.getByRole("link", { name: "gpt-shadowed" }).closest("tr");
    if (!row) throw new Error("gpt-shadowed row not found");
    expect(within(row).getByText("Shadowed")).toBeVisible();
    expect(within(row).getByText("마지막 정상 카탈로그")).toBeVisible();
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
    renderPage(`/gateway/models?provider=${providerRef("openai")}&model=gpt-5&source=live`);

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

  it("marks enrichment cells as checking during their initial load", async () => {
    let resolveQuality: ((value: ModelQualityResponse) => void) | undefined;
    const pendingQuality = new Promise<ModelQualityResponse>((resolve) => {
      resolveQuality = resolve;
    });
    vi.spyOn(apiClient, "request").mockImplementation(async (endpoint) => {
      if (endpoint.path === endpoints.admin.models.list.path) return modelResponse as never;
      if (endpoint.path === endpoints.admin.models.quality.path) return pendingQuality as never;
      if (endpoint.path === endpoints.admin.models.pricing.path) return pricingResponse as never;
      if (endpoint.path === endpoints.admin.models.tags.path) return tagsResponse as never;
      throw new Error(`Unexpected endpoint: ${endpoint.path}`);
    });
    renderPage();

    const row = (await screen.findByRole("link", { name: "gpt-5" })).closest("tr");
    if (!row) throw new Error("gpt-5 row not found");
    await waitFor(() => expect(within(row).getAllByText("확인 중")).toHaveLength(2));

    resolveQuality?.(qualityResponse);
    expect(await within(row).findByText("91점")).toBeVisible();
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
    renderPage(`/gateway/models?provider=${providerRef("openai")}&model=gpt-5&source=live`);

    const dialog = await screen.findByRole("dialog", { name: "gpt-5" });
    expect(await within(dialog).findByText("91점")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "gpt-5" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "7일" }));
    const trigger = screen.getByRole("link", { name: "gpt-5" });
    const row = trigger.closest("tr");
    if (!row) throw new Error("gpt-5 row not found");
    await waitFor(() => expect(within(row).getAllByText("확인 중")).toHaveLength(2));
    await user.click(trigger);
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
    renderPage(`/gateway/models?provider=${providerRef("openai")}&model=gpt-5&source=live`, client);

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
            provider_ref: providerRef("anthropic"),
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

  it("distinguishes a provider partial failure from a genuinely missing deep-linked model", async () => {
    const user = userEvent.setup();
    const request = mockApi({
      models: {
        ...modelResponse,
        partial_failures: [
          {
            code: "provider_models_unavailable",
            message: "Provider model catalog is unavailable.",
            provider: "anthropic",
            provider_ref: providerRef("anthropic"),
          },
        ],
        request_id: "req-provider-partial",
      },
    });
    renderPage(`/gateway/models?model=claude-4&model_provider=${providerRef("anthropic")}&source=live`);

    const dialog = await screen.findByRole("dialog", { name: "claude-4" });
    expect(await within(dialog).findByText("Provider Model 카탈로그를 확인할 수 없습니다.")).toBeVisible();
    expect(within(dialog).getByText(/provider_models_unavailable/)).toBeVisible();
    expect(within(dialog).getByText("Request ID: req-provider-partial")).toBeVisible();
    expect(within(dialog).queryByText("Model을 찾을 수 없습니다.")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Model 카탈로그 상세 재시도" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(5));
  });

  it("treats global and provider-unspecified partial failures as relevant to a deep link", async () => {
    mockApi({
      models: {
        ...modelResponse,
        partial_failures: [
          {
            code: "models_response_limit_exceeded",
            message: "Model response limit exceeded.",
            provider: "*",
            provider_ref: providerRef("system-global"),
          },
        ],
        request_id: "req-global-partial",
      },
    });
    renderPage("/gateway/models?model=not-in-truncated-response");

    const dialog = await screen.findByRole("dialog", { name: "not-in-truncated-response" });
    expect(await within(dialog).findByText("Provider Model 카탈로그를 확인할 수 없습니다.")).toBeVisible();
    expect(within(dialog).getByText(/models_response_limit_exceeded/)).toBeVisible();
    expect(within(dialog).getByText("Request ID: req-global-partial")).toBeVisible();
    expect(within(dialog).queryByText("Model을 찾을 수 없습니다.")).not.toBeInTheDocument();
  });

  it("shows the related partial failure alongside a stale model row", async () => {
    mockApi({
      models: {
        ...modelResponse,
        partial_failures: [
          {
            code: "provider_models_stale",
            message: "Provider refresh failed.",
            provider: "anthropic",
            provider_ref: providerRef("anthropic"),
          },
        ],
        request_id: "req-provider-stale",
      },
    });
    renderPage(
      `/gateway/models?model=shared-model&model_provider=${providerRef("anthropic")}&source=live&provider=${providerRef("anthropic")}`,
    );

    const dialog = await screen.findByRole("dialog", { name: "shared-model" });
    expect(
      await within(dialog).findByText("Provider 갱신에 실패해 마지막 정상 Model을 표시합니다."),
    ).toBeVisible();
    expect(within(dialog).getByText(/provider_models_stale/)).toBeVisible();
    expect(within(dialog).getByText("Request ID: req-provider-stale")).toBeVisible();
  });

  it("disables a model detail retry while the catalogue refresh is running", async () => {
    const user = userEvent.setup();
    let modelCalls = 0;
    let resolveRetry: ((value: AdminModelsResponse) => void) | undefined;
    const retryResult = new Promise<AdminModelsResponse>((resolve) => {
      resolveRetry = resolve;
    });
    vi.spyOn(apiClient, "request").mockImplementation(async (endpoint) => {
      if (endpoint.path === endpoints.admin.models.list.path) {
        modelCalls += 1;
        return (
          modelCalls === 1
            ? {
                ...modelResponse,
                partial_failures: [
                  {
                    code: "provider_models_unavailable",
                    message: "Provider model catalog is unavailable.",
                    provider: "missing-provider",
                    provider_ref: providerRef("missing-provider"),
                  },
                ],
                request_id: "req-retry-disabled",
              }
            : await retryResult
        ) as never;
      }
      if (endpoint.path === endpoints.admin.models.quality.path) return qualityResponse as never;
      if (endpoint.path === endpoints.admin.models.pricing.path) return pricingResponse as never;
      if (endpoint.path === endpoints.admin.models.tags.path) return tagsResponse as never;
      throw new Error(`Unexpected endpoint: ${endpoint.path}`);
    });
    renderPage(`/gateway/models?model=missing&model_provider=${providerRef("missing-provider")}&source=live`);

    const dialog = await screen.findByRole("dialog", { name: "missing" });
    const retry = await within(dialog).findByRole("button", { name: "Model 카탈로그 상세 재시도" });
    await user.click(retry);
    await waitFor(() => expect(retry).toBeDisabled());
    expect(within(dialog).getByText("갱신 중")).toBeVisible();

    resolveRetry?.(modelResponse);
    await waitFor(() => expect(within(dialog).queryByText("갱신 중")).not.toBeInTheDocument());
  });

  it("removes credential searches from deep links and rejects submitted secrets", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage(`/gateway/models?q=eyJheader.eyJpayload.signature&provider=${providerRef("openai")}`);

    const input = screen.getByRole("textbox", { name: "Model 검색" });
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(`provider=${providerRef("openai")}`),
    );
    expect(screen.getByTestId("location")).not.toHaveTextContent("eyJpayload");
    expect(screen.getByRole("alert")).toHaveTextContent("인증정보로 보이는 검색어");
    expect(input).toHaveFocus();

    await user.clear(input);
    await user.type(input, "api_key=private");
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("location")).not.toHaveTextContent("private");
  });

  it("scrubs a secret-like legacy model_provider and renders a generic not-found state", async () => {
    mockApi();
    const unsafeProvider = "Bearer provider-private-value";
    renderPage(`/gateway/models?model=missing-model&model_provider=${encodeURIComponent(unsafeProvider)}`);

    const dialog = await screen.findByRole("dialog", { name: "missing-model" });
    await waitFor(() => expect(screen.getByTestId("location")).not.toHaveTextContent("model_provider="));
    expect(within(dialog).getByText("Model을 찾을 수 없습니다.")).toBeVisible();
    expect(dialog).not.toHaveTextContent(unsafeProvider);
    expect(screen.getByTestId("location")).not.toHaveTextContent("private-value");
  });

  it("shows last-known-good rows after catalogue refresh failure", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(
      ["admin", "models"],
      {
        ...modelResponse,
        partial_failures: [
          {
            code: "provider_models_stale",
            message: "Cached provider failure.",
            provider: "anthropic",
            provider_ref: providerRef("anthropic"),
          },
        ],
        request_id: "req-model-cached-response",
      },
      { updatedAt: Date.now() - 30_000 },
    );
    const request = mockApi({
      modelError: new AppError("Model 목록 갱신 실패", {
        kind: "network",
        requestId: "req-model-lkg",
        retryable: true,
      }),
    });
    renderPage(
      `/gateway/models?model=shared-model&model_provider=${providerRef("anthropic")}&source=live`,
      client,
    );

    const dialog = await screen.findByRole("dialog", { name: "shared-model" });
    expect(
      await within(dialog).findByText("Model 카탈로그 갱신에 실패해 마지막 정상 데이터를 표시합니다."),
    ).toBeVisible();
    expect(within(dialog).getByText("Request ID: req-model-lkg")).toBeVisible();
    expect(within(dialog).queryByText("Request ID: req-model-cached-response")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Cached provider failure/)).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
    expect(within(dialog).getByText("Catalogue")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Model 카탈로그 상세 재시도" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(5));
  });

  it("shows catalogue refresh progress inside an open detail dialog", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["admin", "models"], modelResponse, { updatedAt: Date.now() - 30_000 });
    let resolveModels: ((value: AdminModelsResponse) => void) | undefined;
    const pendingModels = new Promise<AdminModelsResponse>((resolve) => {
      resolveModels = resolve;
    });
    vi.spyOn(apiClient, "request").mockImplementation(async (endpoint) => {
      if (endpoint.path === endpoints.admin.models.list.path) return pendingModels as never;
      if (endpoint.path === endpoints.admin.models.quality.path) return qualityResponse as never;
      if (endpoint.path === endpoints.admin.models.pricing.path) return pricingResponse as never;
      if (endpoint.path === endpoints.admin.models.tags.path) return tagsResponse as never;
      throw new Error(`Unexpected endpoint: ${endpoint.path}`);
    });
    renderPage(`/gateway/models?model=gpt-5&model_provider=${providerRef("openai")}&source=live`, client);

    const dialog = await screen.findByRole("dialog", { name: "gpt-5" });
    expect(await within(dialog).findByText("Model 카탈로그 정보를 갱신하고 있습니다.")).toBeVisible();
    expect(within(dialog).getByText("Catalogue")).toBeVisible();

    resolveModels?.(modelResponse);
    await waitFor(() =>
      expect(within(dialog).queryByText("Model 카탈로그 정보를 갱신하고 있습니다.")).not.toBeInTheDocument(),
    );
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
