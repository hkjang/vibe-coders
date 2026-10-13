import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderPage } from "./ProviderPage";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { RouteQueryGuard } from "@/app/guards/RouteQueryGuard";
import { createAppQueryClient } from "@/app/providers/query-client";
import { migrationRegistry } from "@/config/migration-registry";
import { ApiClient, apiClient } from "@/shared/api/client";
import type { Provider } from "@/shared/api/schemas";
import { usePreferences } from "@/shared/stores/preferences";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

const runtime = vi.hoisted(() => ({ readOnly: false, write: true }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({
        legacyFallback: false,
        scopes: ["admin:read", ...(runtime.write ? ["admin:write"] : [])],
      });
      return {
        ...auth,
        features: auth.features.map((feature) =>
          feature.featureId === "gateway.providers" ? { ...feature, readOnly: runtime.readOnly } : feature,
        ),
      };
    },
  };
});

const caption = "공급자 연결 설정과 운영 상태";
const timestamp = "2026-10-08T08:00:00Z";
const privateA = `prv_${"A".repeat(43)}`;
const privateB = `prv_${"B".repeat(43)}`;
const clients: QueryClient[] = [];
const routers: ReturnType<typeof createMemoryRouter>[] = [];

function provider(name: string, index: number, overrides: Partial<Provider> = {}): Provider {
  return {
    name,
    provider_ref: `prv_${String(index).padStart(43, "x")}`,
    base_url: "https://public-provider.example.invalid/v1",
    api_key_configured: true,
    timeout_ms: 30_000,
    enabled: true,
    model_patterns: "public-*",
    failover_group: "public-group",
    priority: 100,
    created_at: timestamp,
    ...overrides,
  };
}

function fixtures(): Provider[] {
  return [
    ...Array.from({ length: 57 }, (_, index) =>
      provider(`provider-${String(index).padStart(2, "0")}`, index),
    ),
    provider("[provider-name-omitted]", 57, {
      provider_ref: privateA,
      priority: 300,
      timeout_ms: 15_000,
    }),
    provider("[provider-name-omitted]", 58, {
      provider_ref: privateB,
      priority: 300,
      timeout_ms: 16_000,
    }),
    provider("a-late-slow", 59, { priority: 900, timeout_ms: 999_000 }),
    provider("z-late-zero", 60, { priority: 900, timeout_ms: 0 }),
  ].reverse();
}

interface Call {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

async function mount(entry = "/gateway/providers") {
  const calls: Call[] = [];
  let providers = fixtures();
  const transport = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input), "http://provider-sort.example.invalid");
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      // Record every attempted dispatch before handling; no permission/mock guard can make safety pass.
      calls.push({ method, path: url.pathname, query: url.search, body });
      let response: unknown;
      let status = 200;
      if (method === "GET" && url.pathname === "/admin/providers") response = { providers };
      else if (method === "GET" && url.pathname === "/admin/providers/slo")
        response = { slos: [], evaluations: [], since: timestamp };
      else if (method === "POST" && url.pathname === "/admin/providers/slo")
        response = {
          slo: { ...(typeof body === "object" && body !== null ? body : {}), updated_at: timestamp },
        };
      else {
        status = 404;
        response = { error: { message: "Unexpected synthetic endpoint", type: "invalid_request_error" } };
      }
      return new Response(JSON.stringify(response), {
        status,
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
  const client = createAppQueryClient();
  clients.push(client);
  const registered = migrationRegistry.find((item) => item.featureId === "gateway.providers");
  if (!registered) throw new Error("Existing provider feature must be registered");
  const feature = registered;
  let refresh: () => void = () => undefined;
  function Host() {
    const [, redraw] = useState(0);
    refresh = () => redraw((value) => value + 1);
    return (
      <FeatureRoute feature={feature}>
        <ProviderPage />
      </FeatureRoute>
    );
  }
  const router = createMemoryRouter(
    [
      {
        element: (
          <UnsavedChangesProvider blockNavigation>
            <Outlet />
          </UnsavedChangesProvider>
        ),
        children: [
          { element: <RouteQueryGuard />, children: [{ path: "/gateway/providers", element: <Host /> }] },
        ],
      },
    ],
    { initialEntries: [entry] },
  );
  routers.push(router);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => {
    for (const prefix of [
      ["admin", "providers"],
      ["admin", "providers", "slo", "24h"],
    ]) {
      const queries = client.getQueryCache().findAll({
        queryKey: prefix,
        predicate: (query) =>
          query.queryKey.length === prefix.length + 2 && query.queryKey.at(-2) === "provider-read-owner",
      });
      expect(queries).toHaveLength(1);
      expect(queries[0]?.state.status).toBe("success");
    }
    expect(client.isFetching()).toBe(0);
    expect(links().length).toBeGreaterThan(0);
  });
  expect(calls).toHaveLength(2);
  return {
    calls,
    client,
    router,
    setReadonly(value: boolean) {
      runtime.readOnly = value;
      act(refresh);
    },
    async refreshCatalogue(next: Provider[]) {
      providers = next;
      await act(async () => {
        await client.refetchQueries({
          queryKey: ["admin", "providers"],
          predicate: (query) => query.queryKey.length === 4 && query.queryKey[2] === "provider-read-owner",
        });
      });
    },
  };
}

function table() {
  return screen.getByRole("table", { name: caption });
}
function links() {
  return within(table()).queryAllByRole("link");
}
function linkAt(index: number) {
  const link = links()[index];
  if (!link) throw new Error(`Expected provider link at visible index ${index}`);
  return link;
}
function names() {
  return links().map((link) => link.textContent);
}
function row(link: HTMLElement) {
  const result = link.closest("tr");
  if (!result) throw new Error("Existing provider link must belong to a row");
  return result;
}
function sizeControl() {
  return screen.getByRole("combobox", { name: "페이지당 표시 건수" });
}
function params(router: ReturnType<typeof createMemoryRouter>) {
  return new URLSearchParams(router.state.location.search);
}
function expectReadOnlyTransport(calls: Call[], count = 2) {
  expect(calls).toHaveLength(count);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
  expect(calls.some((call) => call.path === "/admin/routing/health")).toBe(false);
}
async function sortOnce(user: ReturnType<typeof userEvent.setup>, label: string, direction: "asc" | "desc") {
  const button = screen.getByRole("button", {
    name: `${label} ${direction === "asc" ? "오름차순" : "내림차순"} 정렬`,
  });
  await user.click(button);
  await waitFor(() =>
    expect(button.closest("th")).toHaveAttribute(
      "aria-sort",
      direction === "asc" ? "ascending" : "descending",
    ),
  );
}

beforeEach(() => {
  runtime.readOnly = false;
  runtime.write = true;
  usePreferences.setState({ refreshInterval: 0 });
});
afterEach(() => {
  cleanup();
  routers.splice(0).forEach((router) => router.dispose());
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

describe("independent ProviderPage local table controls", () => {
  it("positive: preserves priority then public name, ten rows and two existing GETs", async () => {
    const { calls } = await mount();
    expect(fixtures()).toHaveLength(61);
    expect(names()).toEqual(Array.from({ length: 10 }, (_, index) => `provider-0${index}`));
    expect(screen.getByText("1 / 7")).toBeVisible();
    expect(calls.map(({ path, query }) => ({ path, query }))).toEqual([
      { path: "/admin/providers", query: "" },
      { path: "/admin/providers/slo", query: "?window=24h" },
    ]);
    expectReadOnlyTransport(calls);
  });

  it("positive: masked names remain distinct opaque detail identities with no extra API", async () => {
    const user = userEvent.setup();
    const { calls, router } = await mount(`/gateway/providers?q=${encodeURIComponent("공급자 이름 비공개")}`);
    expect(links()).toHaveLength(2);
    expect(links().map((link) => link.dataset.providerTrigger)).toEqual([privateA, privateB]);
    expect(new Set(names()).size).toBe(2);
    await user.click(linkAt(1));
    const dialog = await screen.findByRole("dialog");
    expect(params(router).get("provider")).toBe(privateB);
    expect(dialog).toHaveTextContent("16,000 ms");
    expect(dialog).not.toHaveTextContent("[provider-name-omitted]");
    expectReadOnlyTransport(calls);
  });

  it("positive: existing SLO draft keeps its original target through refresh and readonly restoration", async () => {
    const user = userEvent.setup();
    const current = await mount();
    await user.click(within(row(linkAt(0))).getByRole("button", { name: "서비스 목표" }));
    const dialog = await screen.findByRole("dialog", { name: "공급자 서비스 수준 목표" });
    const note = within(dialog).getByLabelText("메모");
    await user.type(note, "원래 공급자의 공개 초안");
    await current.refreshCatalogue(
      fixtures().map((item) => (item.name === "provider-00" ? { ...item, priority: 999 } : item)),
    );
    expect(note).toHaveValue("원래 공급자의 공개 초안");
    current.setReadonly(true);
    expect(note).toBeDisabled();
    const form = note.closest("form");
    if (!form) throw new Error("Existing SLO note must belong to a form");
    await act(async () => {
      fireEvent.submit(form);
    });
    expectReadOnlyTransport(current.calls, 3);
    current.setReadonly(false);
    expect(note).toHaveValue("원래 공급자의 공개 초안");
    expect(note).toBeEnabled();
    expectReadOnlyTransport(current.calls, 3);
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(current.calls.filter((call) => call.method === "POST")).toHaveLength(1));
    expect(current.calls.find((call) => call.method === "POST")).toMatchObject({
      path: "/admin/providers/slo",
      body: { provider: "provider-00", note: "원래 공급자의 공개 초안" },
    });
  });

  it("sorts all received rows before slicing and keeps a valid zero timeout", async () => {
    const user = userEvent.setup();
    const { calls, router } = await mount("/gateway/providers?page=3");
    expect(names()).not.toContain("z-late-zero");
    await sortOnce(user, "제한 시간", "asc");
    expect(names()[0]).toBe("z-late-zero");
    expect(links()).toHaveLength(10);
    expect(within(row(linkAt(0))).getByText("0 ms")).toBeVisible();
    expect(params(router).get("sort")).toBe("timeout_asc");
    expect(params(router).get("page")).toBeNull();
    await sortOnce(user, "제한 시간", "desc");
    expect(names()[0]).toBe("a-late-slow");
    expectReadOnlyTransport(calls);
  });

  it("applies a Korean multi-sort draft once, restores history and keeps header sorting single-column", async () => {
    const user = userEvent.setup();
    const { calls, router } = await mount("/gateway/providers?sort=name_desc&page_size=25&page=2");
    const trigger = screen.getByRole("button", { name: "다중 정렬" });
    await user.click(trigger);
    await user.selectOptions(screen.getByRole("combobox", { name: "1순위 정렬 열" }), "failover");
    await user.selectOptions(screen.getByRole("combobox", { name: "1순위 정렬 방향" }), "desc");
    await user.click(screen.getByRole("button", { name: "정렬 기준 추가" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "2순위 정렬 열" }), "timeout");
    await user.selectOptions(screen.getByRole("combobox", { name: "2순위 정렬 방향" }), "asc");
    expect(params(router).get("sort")).toBe("name_desc");
    await user.click(screen.getByRole("button", { name: "정렬 적용" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(params(router).get("sort")).toBe("priority_desc,timeout_asc");
    expect(params(router).get("page")).toBeNull();
    expect(params(router).get("page_size")).toBe("25");
    expect(names().slice(0, 2)).toEqual(["z-late-zero", "a-late-slow"]);
    await act(async () => {
      await router.navigate(-1);
    });
    expect(params(router).get("sort")).toBe("name_desc");
    expect(params(router).get("page")).toBe("2");
    await act(async () => {
      await router.navigate(1);
    });
    await sortOnce(user, "우선순위", "asc");
    expect(params(router).get("sort")).toBe("priority_asc");
    expectReadOnlyTransport(calls);
  });

  it("preserves default ties under descending priority and restores the original order", async () => {
    const user = userEvent.setup();
    const { calls, router } = await mount();
    await sortOnce(user, "우선순위", "asc");
    await sortOnce(user, "우선순위", "desc");
    expect(names().slice(0, 2)).toEqual(["a-late-slow", "z-late-zero"]);
    expect(names().slice(4)).toEqual(Array.from({ length: 6 }, (_, index) => `provider-0${index}`));
    await user.click(screen.getByRole("button", { name: "기본 순서" }));
    expect(names()).toEqual(Array.from({ length: 10 }, (_, index) => `provider-0${index}`));
    expect(params(router).get("sort")).toBeNull();
    expectReadOnlyTransport(calls);
  });

  it("sorts only public names and keeps masked provider references distinct", async () => {
    const user = userEvent.setup();
    const { calls, router } = await mount(`/gateway/providers?q=${encodeURIComponent("공급자 이름 비공개")}`);
    await sortOnce(user, "공급자", "asc");
    expect(links().map((link) => link.dataset.providerTrigger)).toEqual([privateA, privateB]);
    await sortOnce(user, "공급자", "desc");
    expect(links().map((link) => link.dataset.providerTrigger)).toEqual([privateB, privateA]);
    await user.click(linkAt(0));
    await screen.findByRole("dialog");
    expect(params(router).get("provider")).toBe(privateB);
    expect(params(router).get("sort")).toBe("name_desc");
    expectReadOnlyTransport(calls);
  });

  it("uses 10/25/50 local rows and restores sort and page-size history without refetching", async () => {
    const user = userEvent.setup();
    const { calls, router } = await mount();
    expect(sizeControl()).toHaveValue("10");
    await user.selectOptions(sizeControl(), "25");
    expect(links()).toHaveLength(25);
    expect(params(router).get("page_size")).toBe("25");
    await user.selectOptions(sizeControl(), "50");
    expect(links()).toHaveLength(50);
    await sortOnce(user, "제한 시간", "asc");
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => expect(params(router).get("sort")).toBeNull());
    expect(sizeControl()).toHaveValue("50");
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => expect(sizeControl()).toHaveValue("25"));
    expect(links()).toHaveLength(25);
    await act(async () => {
      await router.navigate(1);
    });
    await waitFor(() => expect(sizeControl()).toHaveValue("50"));
    await user.selectOptions(sizeControl(), "10");
    expect(links()).toHaveLength(10);
    expect(params(router).get("page_size")).toBeNull();
    expectReadOnlyTransport(calls);
  });

  it("restores guarded deep links and clamps a filtered page without losing sort or size", async () => {
    const user = userEvent.setup();
    const { calls, router } = await mount("/gateway/providers?sort=timeout_desc&page_size=25&page=99");
    expect(sizeControl()).toHaveValue("25");
    await waitFor(() => expect(params(router).get("page")).toBe("3"));
    expect(links()).toHaveLength(11);
    await user.type(screen.getByLabelText("공급자 검색"), "provider-0");
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(links()).toHaveLength(10);
    expect(params(router).get("page")).toBeNull();
    expect(params(router).get("sort")).toBe("timeout_desc");
    expect(params(router).get("page_size")).toBe("25");
    expectReadOnlyTransport(calls);
  });

  it("allows new local controls under feature readonly while existing mutations remain disabled", async () => {
    runtime.readOnly = true;
    const user = userEvent.setup();
    const { calls } = await mount();
    expect(screen.getByRole("button", { name: "공급자 추가" })).toBeDisabled();
    for (const name of ["수정", "중지", "서비스 목표", "삭제"])
      expect(within(row(linkAt(0))).getByRole("button", { name })).toBeDisabled();
    await sortOnce(user, "제한 시간", "asc");
    await user.selectOptions(sizeControl(), "25");
    expect(names()[0]).toBe("z-late-zero");
    expect(links()).toHaveLength(25);
    expectReadOnlyTransport(calls);
  });

  it("preserves a sorted page's exact write target and dirty draft across refreshed row movement", async () => {
    const user = userEvent.setup();
    const current = await mount();
    await sortOnce(user, "제한 시간", "asc");
    await user.selectOptions(sizeControl(), "25");
    expect(names()[0]).toBe("z-late-zero");
    await user.click(within(row(linkAt(0))).getByRole("button", { name: "서비스 목표" }));
    const dialog = await screen.findByRole("dialog", { name: "공급자 서비스 수준 목표" });
    const note = within(dialog).getByLabelText("메모");
    await user.type(note, "정렬 전에 선택한 동일 대상");
    await current.refreshCatalogue(
      fixtures().map((item) => (item.name === "z-late-zero" ? { ...item, timeout_ms: 999_999 } : item)),
    );
    expect(note).toHaveValue("정렬 전에 선택한 동일 대상");
    expectReadOnlyTransport(current.calls, 3);
    await act(async () => {
      await current.router.navigate("/gateway/providers?sort=name_asc&page_size=25");
    });
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(within(confirmation).getByRole("button", { name: "계속 편집" }));
    expect(params(current.router).get("sort")).toBe("timeout_asc");
    expect(note).toHaveValue("정렬 전에 선택한 동일 대상");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(current.calls.filter((call) => call.method === "POST")).toHaveLength(1));
    expect(current.calls.find((call) => call.method === "POST")).toMatchObject({
      path: "/admin/providers/slo",
      body: { provider: "z-late-zero", note: "정렬 전에 선택한 동일 대상" },
    });
  });
});
