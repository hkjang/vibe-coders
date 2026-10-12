import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelPage } from "@/features/gateway/models/ModelPage";
import { ApiClient, apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type {
  AdminModel,
  AdminModelsResponse,
  ModelQualityResponse,
  PricingResponse,
} from "@/shared/api/schemas";
import { usePreferences } from "@/shared/stores/preferences";

// The UI and ApiClient are real; observed authentication and every HTTP response
// are synthetic. This is not an actual Go/auth integration or permission test.
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    authenticationMode: "session",
    legacyFallback: false,
    mode: "authenticated",
    user: { id: "public-reader", role: "viewer", roles: ["viewer"], scopes: ["admin:read"] },
  }),
}));

const providerRef = `prv_${"a".repeat(43)}`;
const timestamp = "2026-10-08T03:00:00Z";
const caption = "공급자별 모델 상태, 품질과 가격";
const clients: QueryClient[] = [];
type ReadCall = { path: string; method: string; query: string };

function model(id: string): AdminModel {
  return {
    created: 1_700_000_000,
    deprecation: null,
    fetched_at: timestamp,
    id,
    object: "model",
    owned_by: "public-owner",
    provider: "alpha",
    provider_ref: providerRef,
    shadowed: false,
    shadowed_by: "",
    source: "live",
    stale: false,
    virtual: false,
  };
}

function fixtures() {
  const catalogue: AdminModelsResponse = {
    generated_at: timestamp,
    models: [model("sample-eval-only"), model("sample-observed-zero")],
    partial_failures: [],
    providers: [
      {
        fetched_at: timestamp,
        model_count: 2,
        provider: "alpha",
        provider_ref: providerRef,
        source: "live",
        stale: false,
        status: "ok",
      },
    ],
    request_id: "public-model-detail-samples",
  };
  const quality: ModelQualityResponse = {
    categories: [],
    since: "2026-10-07T03:00:00Z",
    models: [
      {
        // Four passing evaluations out of five can belong to older requests
        // outside the selected request window. No request-success observation;
        // the available evaluation signal still produces a valid 80-point score.
        categories: {},
        eval_pass_rate: 0.8,
        eval_samples: 5,
        golden_pass_rate: 0,
        golden_samples: 0,
        model: "sample-eval-only",
        quality_score: 80,
        requests: 0,
        success_rate: 0,
      },
      {
        // Five observed failed requests and no other signals: both zero values
        // are real measurements, not missing enrichment or absent samples.
        categories: {},
        eval_pass_rate: 0,
        eval_samples: 0,
        golden_pass_rate: 0,
        golden_samples: 0,
        model: "sample-observed-zero",
        quality_score: 0,
        requests: 5,
        success_rate: 0,
      },
    ],
  };
  const pricing: PricingResponse = {
    effective: {
      "alpha/sample-observed-zero": {
        cached_input_krw_per_1m: 0,
        input_krw_per_1m: 0,
        output_krw_per_1m: 0,
      },
    },
    versions: [],
  };
  return { catalogue, quality, pricing };
}

function mount() {
  const fixture = fixtures();
  const calls: ReadCall[] = [];
  const transport = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input), "http://public-model-detail.invalid");
      const method = init?.method ?? "GET";
      calls.push({ path: url.pathname, method, query: url.search });
      if (method !== "GET") throw new Error("Unexpected write in read-only detail fixture");
      let body: unknown;
      if (url.pathname === endpoints.admin.models.list.path) body = fixture.catalogue;
      else if (url.pathname === endpoints.admin.models.quality.path) body = fixture.quality;
      else if (url.pathname === endpoints.admin.models.pricing.path) body = fixture.pricing;
      else if (url.pathname === endpoints.admin.models.tags.path) body = { tags: [] };
      else throw new Error("Unexpected synthetic model endpoint");
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
      <MemoryRouter initialEntries={["/gateway/models"]}>
        <ModelPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls, client };
}

async function loaded(client: QueryClient, calls: ReadCall[]) {
  await screen.findByRole("table", { name: caption });
  await waitFor(() => expect(calls).toHaveLength(4));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await waitFor(() =>
    expect(within(screen.getByRole("table", { name: caption })).queryAllByText("확인 중")).toHaveLength(0),
  );
}

function modelLink(id: string) {
  return within(screen.getByRole("table", { name: caption })).getByRole("link", { name: id });
}

function modelRow(id: string) {
  const row = modelLink(id).closest("tr");
  if (!row) throw new Error("Expected model link inside its public table row");
  return row;
}

function definitionValue(dialog: HTMLElement, label: string): HTMLElement {
  const term = within(dialog).getByText(label, { selector: "dt", exact: true });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement) || value.tagName !== "DD")
    throw new Error("Expected the corresponding public definition value");
  return value;
}

function expectOnlyInitialReads(calls: ReadCall[]) {
  expect(calls).toHaveLength(4);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
  expect(calls.filter((call) => call.query !== "")).toEqual([
    { path: endpoints.admin.models.quality.path, method: "GET", query: "?window=24h" },
  ]);
}

beforeEach(() => {
  usePreferences.setState({ refreshInterval: 0 });
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

describe("independent ModelPage list-to-detail request sample contract", () => {
  it("keeps no-request success unknown in the same model detail without hiding evaluation quality", async () => {
    const user = userEvent.setup();
    const { calls, client } = mount();
    await loaded(client, calls);
    const row = modelRow("sample-eval-only");
    expect(within(row).getByText("요청 표본 없음")).toBeVisible();
    expect(within(row).queryByText("0%", { exact: true })).not.toBeInTheDocument();
    expect(within(row).getByText("80점")).toBeVisible();

    await user.click(modelLink("sample-eval-only"));
    const dialog = await screen.findByRole("dialog", { name: "sample-eval-only" });
    expect(definitionValue(dialog, "종합 품질")).toHaveTextContent(/^80점$/);
    expect(definitionValue(dialog, "평가")).toHaveTextContent(/^80% · 5건$/);
    expectOnlyInitialReads(calls);
    // Scope only this dt/dd: the separate golden row can legitimately show
    // "0% · 0건" under its existing sample-count presentation.
    expect(definitionValue(dialog, "요청 성공률")).toHaveTextContent(/^요청 표본 없음$/);
  });

  it("keeps observed zero-percent success, zero quality and free pricing in the same model detail", async () => {
    const user = userEvent.setup();
    const { calls, client } = mount();
    await loaded(client, calls);
    const row = modelRow("sample-observed-zero");
    expect(within(row).getByText("0%", { exact: true })).toBeVisible();
    expect(within(row).getByText("0점")).toBeVisible();
    expect(within(row).getAllByText("₩0", { exact: true })).toHaveLength(2);
    expect(within(row).queryByText("요청 표본 없음")).not.toBeInTheDocument();

    await user.click(modelLink("sample-observed-zero"));
    const dialog = await screen.findByRole("dialog", { name: "sample-observed-zero" });
    expect(definitionValue(dialog, "요청 성공률")).toHaveTextContent(/^0%$/);
    expect(definitionValue(dialog, "종합 품질")).toHaveTextContent(/^0점$/);
    expect(definitionValue(dialog, "입력 / 100만 토큰")).toHaveTextContent(/^₩0$/);
    expect(definitionValue(dialog, "출력 / 100만 토큰")).toHaveTextContent(/^₩0$/);
    expect(definitionValue(dialog, "캐시 입력 / 100만 토큰")).toHaveTextContent(/^₩0$/);
    expectOnlyInitialReads(calls);
  });
});
