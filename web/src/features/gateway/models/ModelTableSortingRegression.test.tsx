import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelPage } from "./ModelPage";
import { ApiClient, apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type {
  AdminModel,
  AdminModelsResponse,
  ModelQualityResponse,
  ModelQualityScore,
  PricingResponse,
} from "@/shared/api/schemas";
import { usePreferences } from "@/shared/stores/preferences";

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    authenticationMode: "session",
    legacyFallback: false,
    mode: "authenticated",
    user: { id: "public-reader", role: "viewer", roles: ["viewer"], scopes: ["admin:read"] },
  }),
}));

const alphaRef = `prv_${"a".repeat(43)}`;
const betaRef = `prv_${"b".repeat(43)}`;
const timestamp = "2026-10-08T03:00:00Z";
const caption = "공급자별 모델 상태, 품질과 가격";
const ordinaryIds = Array.from({ length: 52 }, (_, index) => `model-${String(index).padStart(2, "0")}`);
const clients: QueryClient[] = [];

function model(id: string, overrides: Partial<AdminModel> = {}): AdminModel {
  return {
    created: 1_700_000_000,
    deprecation: null,
    fetched_at: timestamp,
    id,
    object: "model",
    owned_by: "public-owner",
    provider: "alpha",
    provider_ref: alphaRef,
    shadowed: false,
    shadowed_by: "",
    source: "live",
    stale: false,
    virtual: false,
    ...overrides,
  };
}

function score(modelId: string, overrides: Partial<ModelQualityScore> = {}): ModelQualityScore {
  return {
    categories: {},
    eval_pass_rate: 0.8,
    eval_samples: 5,
    golden_pass_rate: 0,
    golden_samples: 0,
    model: modelId,
    quality_score: 40,
    requests: 10,
    success_rate: 0.5,
    ...overrides,
  };
}

function fixtures() {
  const models = [
    ...ordinaryIds.map((id, index) => model(id, index === 0 ? { stale: true, source: "cache" } : {})),
    model("z-free"),
    model("z-best"),
    model("signal-eval-only"),
    model("signal-observed-zero"),
    model("signal-unknown"),
    model("tie-model"),
    model("tie-model", { source: "agent_route", virtual: true }),
    model("tie-model", { provider: "beta", provider_ref: betaRef }),
    model("z-expensive"),
  ];
  const catalogue: AdminModelsResponse = {
    generated_at: timestamp,
    // Deliberately reverse the wire order; default and tie order must be explicit.
    models: [...models].reverse(),
    partial_failures: [
      {
        code: "provider_models_stale",
        message: "Public fixture stale",
        provider: "alpha",
        provider_ref: alphaRef,
      },
    ],
    providers: [
      {
        fetched_at: timestamp,
        model_count: 60,
        provider: "alpha",
        provider_ref: alphaRef,
        source: "live",
        stale: true,
        status: "ok",
      },
      {
        fetched_at: timestamp,
        model_count: 1,
        provider: "beta",
        provider_ref: betaRef,
        source: "live",
        stale: false,
        status: "ok",
      },
    ],
    request_id: "public-model-sort-fixture",
  };
  const quality: ModelQualityResponse = {
    categories: [],
    since: "2026-10-07T03:00:00Z",
    models: [
      ...ordinaryIds.map((id) => score(id)),
      score("z-free", { quality_score: 33 }),
      score("z-best", { quality_score: 100, success_rate: 1 }),
      score("signal-eval-only", { quality_score: 95, requests: 0, success_rate: 0 }),
      score("signal-observed-zero", { quality_score: 0, requests: 5, success_rate: 0 }),
      score("tie-model", { quality_score: 80 }),
      score("z-expensive", { quality_score: 50 }),
    ],
  };
  const pricing: PricingResponse = {
    effective: Object.fromEntries(
      models
        .filter((item) => item.id !== "signal-unknown")
        .map((item) => [
          `${item.provider}/${item.id}`,
          {
            cached_input_krw_per_1m: 0,
            input_krw_per_1m: item.id === "z-free" ? 0 : item.id === "z-expensive" ? 9999 : 100,
            output_krw_per_1m: item.id === "z-best" ? 0 : item.id === "z-free" ? 9999 : 200,
          },
        ]),
    ),
    versions: [],
  };
  return { catalogue, quality, pricing };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="model-location">{location.pathname + location.search}</output>;
}

function mount(entry = "/gateway/models") {
  const fixture = fixtures();
  const calls: Array<{ path: string; method: string; query: string }> = [];
  let catalogueStatus = 200;
  const transport = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input), "http://public-model-test.invalid");
      const method = init?.method ?? "GET";
      calls.push({ path: url.pathname, method, query: url.search });
      if (method !== "GET") throw new Error("Unexpected write in read-only model fixture");
      let body: unknown;
      let status = 200;
      if (url.pathname === endpoints.admin.models.list.path) {
        status = catalogueStatus;
        body =
          status === 200
            ? fixture.catalogue
            : { error: { message: "Synthetic unavailable", type: "server_error" } };
      } else if (url.pathname === endpoints.admin.models.quality.path) body = fixture.quality;
      else if (url.pathname === endpoints.admin.models.pricing.path) body = fixture.pricing;
      else if (url.pathname === endpoints.admin.models.tags.path) body = { tags: [] };
      else throw new Error("Unexpected synthetic model endpoint");
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
    getAccessToken: () => "",
    getRefreshToken: () => "",
    getLegacyToken: () => "",
    getSessionEpoch: () => 1,
    saveTokens: vi.fn(),
    clearTokens: vi.fn(),
    notifyLogout: vi.fn(),
  });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
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
  return {
    calls,
    client,
    failCatalogue: () => {
      catalogueStatus = 503;
    },
  };
}

function table() {
  return screen.getByRole("table", { name: caption });
}
function links() {
  return within(table()).getAllByRole("link");
}
function firstLink() {
  const link = links()[0];
  if (!link) throw new Error("Expected at least one visible model link");
  return link;
}
function ids() {
  return links().map((link) => link.textContent);
}
function identities() {
  return links().map((link) => link.dataset.modelTrigger);
}
function rowFor(link: HTMLElement) {
  const row = link.closest("tr");
  if (!row) throw new Error("Expected model link inside a table row");
  return row;
}
function currentLocation() {
  const value = screen.getByTestId("model-location").textContent;
  if (!value) throw new Error("Expected current model route location");
  return new URL(value, "http://public-model-test.invalid");
}
function header(label: string) {
  const found = within(table())
    .getAllByRole("columnheader")
    .find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`Missing expected public header: ${label}`);
  return found;
}
async function sortBy(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  direction: "ascending" | "descending",
) {
  const control = within(header(label)).getByRole("button");
  await user.click(control);
  if (header(label).getAttribute("aria-sort") !== direction)
    await user.click(within(header(label)).getByRole("button"));
  expect(header(label)).toHaveAttribute("aria-sort", direction);
}
async function loaded(calls: Array<unknown>) {
  await screen.findByRole("table", { name: caption });
  await waitFor(() => expect(calls).toHaveLength(4));
  await waitFor(() => expect(within(table()).queryAllByText("확인 중")).toHaveLength(0));
}
function noAdditionalReadsOrWrites(calls: Array<{ method: string }>, expected = 4) {
  expect(calls).toHaveLength(expected);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
}

beforeEach(() => {
  usePreferences.setState({ refreshInterval: 0 });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

describe("independent ModelPage received-list ordering contract", () => {
  it("preserves the compound default order, ten rows, partial/stale notices and read-only transport", async () => {
    const { calls } = mount();
    await loaded(calls);
    expect(fixtures().catalogue.models).toHaveLength(61);
    expect(ids()).toEqual(ordinaryIds.slice(0, 10));
    expect(screen.getByText("일부 공급자의 모델 목록을 갱신하지 못했습니다.")).toBeVisible();
    expect(within(rowFor(firstLink())).getByText("이전 데이터")).toBeVisible();
    expect(screen.getByText("요청 ID: public-model-sort-fixture")).toBeVisible();
    expect(calls.filter((call) => call.query !== "")).toEqual([
      { path: endpoints.admin.models.quality.path, method: "GET", query: "?window=24h" },
    ]);
    noAdditionalReadsOrWrites(calls);
  });

  it("keeps existing last-page navigation local and preserves the final duplicate provider identity", async () => {
    const user = userEvent.setup();
    const { calls } = mount("/gateway/models?page=7");
    await loaded(calls);
    expect(ids()).toEqual(["tie-model"]);
    expect(identities()).toEqual([JSON.stringify([betaRef, "tie-model", "live"])]);
    await user.click(screen.getByRole("button", { name: "이전" }));
    expect(links()).toHaveLength(10);
    noAdditionalReadsOrWrites(calls);
  });

  it("keeps stale successful rows and explicit catalogue failure information after a 503", async () => {
    const { calls, client, failCatalogue } = mount();
    await loaded(calls);
    failCatalogue();
    await act(async () => {
      await client.refetchQueries({ queryKey: ["admin", "models"], exact: true });
    });
    expect(ids()).toEqual(ordinaryIds.slice(0, 10));
    expect(await screen.findByText(/마지막 정상 데이터를 표시합니다/)).toBeVisible();
    expect(screen.getByText("일부 공급자의 모델 목록을 갱신하지 못했습니다.")).toBeVisible();
    noAdditionalReadsOrWrites(calls, 5);
  });

  it("sorts all 61 received rows before slicing so a zero-price off-page model becomes first", async () => {
    const user = userEvent.setup();
    const { calls } = mount("/gateway/models?page=3");
    await loaded(calls);
    expect(ids()).not.toContain("z-free");
    await sortBy(user, "입력 / 100만 토큰", "ascending");
    expect(ids()[0]).toBe("z-free");
    expect(links()).toHaveLength(10);
    expect(currentLocation().searchParams.get("page")).toBeNull();
    await sortBy(user, "입력 / 100만 토큰", "descending");
    expect(ids()[0]).toBe("z-expensive");
    noAdditionalReadsOrWrites(calls);
  });

  it("sorts numeric quality in both directions while keeping a valid zero ahead of missing enrichment", async () => {
    const user = userEvent.setup();
    const { calls } = mount();
    await loaded(calls);
    expect(ids()).not.toContain("z-best");
    await sortBy(user, "품질", "descending");
    expect(ids()[0]).toBe("z-best");
    await sortBy(user, "품질", "ascending");
    expect(ids()[0]).toBe("signal-observed-zero");
    expect(within(rowFor(firstLink())).getByText("0점")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("페이지당 표시 건수"), "50");
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(ids().at(-1)).toBe("signal-unknown");
    noAdditionalReadsOrWrites(calls);
  });

  it("distinguishes an evaluation-only no-request sample from observed zero-percent success", async () => {
    const { calls } = mount("/gateway/models?q=signal");
    await loaded(calls);
    const evalRow = rowFor(screen.getByRole("link", { name: "signal-eval-only" }));
    const observedRow = rowFor(screen.getByRole("link", { name: "signal-observed-zero" }));
    expect(within(evalRow).getByText("요청 표본 없음")).toBeVisible();
    expect(within(evalRow).queryByText("0%")).not.toBeInTheDocument();
    expect(within(observedRow).getByText("0%")).toBeVisible();
    noAdditionalReadsOrWrites(calls);
  });

  it("puts no-request and missing success samples last in both directions without converting them to zero", async () => {
    const user = userEvent.setup();
    const { calls } = mount("/gateway/models?q=signal");
    await loaded(calls);
    await sortBy(user, "성공률", "descending");
    expect(ids()).toEqual(["signal-observed-zero", "signal-eval-only", "signal-unknown"]);
    await sortBy(user, "성공률", "ascending");
    expect(ids()).toEqual(["signal-observed-zero", "signal-eval-only", "signal-unknown"]);
    noAdditionalReadsOrWrites(calls);
  });

  it("uses raw output prices and keeps unavailable prices last in either direction", async () => {
    const user = userEvent.setup();
    const { calls } = mount();
    await loaded(calls);
    await sortBy(user, "출력 / 100만 토큰", "ascending");
    expect(ids()[0]).toBe("z-best");
    await user.selectOptions(screen.getByLabelText("페이지당 표시 건수"), "50");
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(ids().at(-1)).toBe("signal-unknown");
    await sortBy(user, "출력 / 100만 토큰", "descending");
    expect(ids()[0]).toBe("z-free");
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(ids().at(-1)).toBe("signal-unknown");
    noAdditionalReadsOrWrites(calls);
  });

  it("supports local 10/25/50 sizes, resets page on size changes and restores the original compound order", async () => {
    const user = userEvent.setup();
    const { calls } = mount();
    await loaded(calls);
    const size = screen.getByLabelText("페이지당 표시 건수");
    expect(
      within(size)
        .getAllByRole("option")
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(["10", "25", "50"]);
    await user.selectOptions(size, "25");
    expect(ids()).toEqual(ordinaryIds.slice(0, 25));
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(ids()).toEqual(ordinaryIds.slice(25, 50));
    await user.selectOptions(size, "50");
    expect(ids()).toEqual(ordinaryIds.slice(0, 50));
    await sortBy(user, "품질", "descending");
    expect(ids()[0]).toBe("z-best");
    await user.click(screen.getByRole("button", { name: "기본 순서" }));
    expect(ids()).toEqual(ordinaryIds.slice(0, 50));
    await user.selectOptions(size, "10");
    expect(ids()).toEqual(ordinaryIds.slice(0, 10));
    noAdditionalReadsOrWrites(calls);
  });

  it("retains deterministic ties and exact provider/model/source detail identity under both sort directions", async () => {
    const user = userEvent.setup();
    const { calls } = mount("/gateway/models?q=tie-model");
    await loaded(calls);
    const expected = [
      JSON.stringify([alphaRef, "tie-model", "agent_route"]),
      JSON.stringify([alphaRef, "tie-model", "live"]),
      JSON.stringify([betaRef, "tie-model", "live"]),
    ];
    expect(identities()).toEqual(expected);
    await sortBy(user, "품질", "descending");
    expect(identities()).toEqual(expected);
    await sortBy(user, "품질", "ascending");
    expect(identities()).toEqual(expected);
    await user.click(firstLink());
    const dialog = await screen.findByRole("dialog", { name: "tie-model" });
    expect(within(dialog).getByText("에이전트 경로")).toBeVisible();
    const location = currentLocation();
    expect(location.searchParams.get("model_provider")).toBe(alphaRef);
    expect(location.searchParams.get("source")).toBe("agent_route");
    expect(location.searchParams.get("model")).toBe("tie-model");
    noAdditionalReadsOrWrites(calls);
  });
});
