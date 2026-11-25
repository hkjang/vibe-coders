import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { FeatureAccessContext } from "@/shared/feature-access/context";

import { DynamicRoutesPage } from "./DynamicRoutesPage";

let scopes = ["routing:read", "routing:write"];
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({ mode: "authenticated", user: { scopes } }),
}));

const route = {
  id: "drt_1",
  name: "support",
  description: "고객 지원 챗봇",
  enabled: true,
  deployed_version: 1,
  latest_version: 2,
  deployed_at: "2026-11-24T00:00:00Z",
  created_by: "ops",
  updated_by: "ops",
  created_at: "2026-11-20T00:00:00Z",
  updated_at: "2026-11-24T00:00:00Z",
  call_model: "dynamic/support",
  state: "live_with_draft",
  traffic_24h: { requests: 1234, failures: 5, fallbacks: 7 },
};

const graph = {
  elements: [
    { id: "start", type: "start", properties: {}, outputs: { next: { elementId: "plan" } } },
    {
      id: "plan",
      type: "conditional",
      properties: { conditions: { "metadata.plan": { $eq: "free" } } },
      outputs: { true: { elementId: "cheap" }, false: { elementId: "premium" } },
    },
    {
      id: "premium",
      type: "model",
      properties: { model: "big-model", provider: "openai" },
      outputs: { success: { elementId: "end" }, fallback: { elementId: "cheap" } },
    },
    {
      id: "cheap",
      type: "model",
      properties: { model: "small-model" },
      outputs: { success: { elementId: "end" } },
    },
    { id: "end", type: "end", properties: {} },
  ],
};

const detail = {
  route,
  versions: [
    {
      route_id: "drt_1",
      version: 2,
      note: "폴백 추가",
      created_by: "ops",
      created_at: "2026-11-24T00:00:00Z",
    },
    { route_id: "drt_1", version: 1, note: "처음", created_by: "ops", created_at: "2026-11-20T00:00:00Z" },
  ],
  latest: {
    route_id: "drt_1",
    version: 2,
    note: "폴백 추가",
    created_by: "ops",
    created_at: "2026-11-24T00:00:00Z",
    graph,
  },
  fields: [{ field: "identity.team", description: "팀" }],
};

type Handler = (body: unknown) => unknown;

function mockApi(handlers: Record<string, Handler>) {
  return vi.spyOn(apiClient, "request").mockImplementation((async (
    endpoint: { method: string; path: string },
    options?: { body?: unknown },
  ) => {
    // Path parameters are already filled in; match them back to the template.
    const template = endpoint.path
      .replace(/\/drt_[^/]+/u, "/{id}")
      .replace(/\/versions\/\d+$/u, "/versions/{version}");
    const handler = handlers[`${endpoint.method} ${template}`];
    if (!handler) throw new Error(`unexpected request ${endpoint.method} ${endpoint.path}`);
    return handler(options?.body);
  }) as never);
}

function renderAt(path: string, readOnly = false) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <FeatureAccessContext.Provider value={{ featureId: "routing.dynamic", permitted: true, readOnly }}>
          <DynamicRoutesPage />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const valid = { valid: true, graph, validation: { errors: [], warnings: [] } };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  scopes = ["routing:read", "routing:write"];
});

describe("DynamicRoutesPage list", () => {
  it("shows each route with how to call it, its state and traffic", async () => {
    mockApi({ "GET /admin/routing/dynamic-routes": () => ({ routes: [route], count: 1, fields: [] }) });
    renderAt("/routing/dynamic");
    const row = (await screen.findByRole("link", { name: "support" })).closest("tr") as HTMLElement;
    expect(within(row).getByText("dynamic/support")).toBeVisible();
    expect(within(row).getByText("배포됨 · 새 버전 대기")).toBeVisible();
    expect(within(row).getByText("1,234")).toBeVisible();
  });

  it("offers templates on an empty list and keeps creation behind routing:write", async () => {
    scopes = ["routing:read"];
    mockApi({ "GET /admin/routing/dynamic-routes": () => ({ routes: [], count: 0, fields: [] }) });
    renderAt("/routing/dynamic");
    expect(await screen.findByText("아직 동적 경로가 없습니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: /새 경로/u })).toBeDisabled();
  });

  it("creates a route from a template with the chosen models", async () => {
    const request = mockApi({
      "GET /admin/routing/dynamic-routes": () => ({ routes: [], count: 0, fields: [] }),
      "POST /admin/routing/dynamic-routes": () => ({
        route: { ...route, id: "drt_new" },
        validation: { errors: [], warnings: [] },
      }),
      "GET /admin/routing/dynamic-routes/{id}": () => detail,
      "POST /admin/routing/dynamic-routes/validate": () => valid,
    });
    renderAt("/routing/dynamic");
    fireEvent.click(await screen.findByRole("button", { name: /새 경로/u }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^경로 이름/u), { target: { value: "Support" } });
    fireEvent.change(within(dialog).getByLabelText(/^기본 모델/u), { target: { value: "gpt-4.1" } });
    fireEvent.change(within(dialog).getByLabelText(/^보조 모델/u), { target: { value: "gpt-4.1-mini" } });
    expect(within(dialog).getByText("호출 모델: dynamic/support")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ method: "POST", path: "/admin/routing/dynamic-routes" }),
        expect.objectContaining({ retryUnauthorized: false }),
      ),
    );
    const call = request.mock.calls.find(([endpoint]) => (endpoint as { method: string }).method === "POST");
    const body = (call?.[1] as { body: { name: string; deploy: boolean; graph: typeof graph } }).body;
    expect(body.name).toBe("support");
    expect(body.deploy).toBe(false);
    expect(
      body.graph.elements
        .filter((element) => element.type === "model")
        .map((element) => (element.properties as { model: string }).model),
    ).toEqual(["gpt-4.1", "gpt-4.1-mini"]);
  });
});

describe("DynamicRoutesPage editor", () => {
  it("draws the flow, edits an element and saves a version on top of the loaded one", async () => {
    const request = mockApi({
      "GET /admin/routing/dynamic-routes/{id}": () => detail,
      "POST /admin/routing/dynamic-routes/validate": () => valid,
      "POST /admin/routing/dynamic-routes/{id}/versions": () => ({
        route: { ...route, latest_version: 3 },
        validation: { errors: [], warnings: [] },
      }),
    });
    renderAt("/routing/dynamic/drt_1");
    const premium = await screen.findByRole("button", { name: /모델 premium/u });
    expect(premium).toHaveAccessibleName(expect.stringContaining("실패 시 → cheap"));
    fireEvent.click(premium);
    const save = screen.getByRole("button", { name: "새 버전으로 저장" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "모델" }), { target: { value: "bigger-model" } });
    await waitFor(() => expect(screen.getByText("오류가 없습니다.", { exact: false })).toBeVisible());
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/변경 메모/u), { target: { value: "모델 교체" } });
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(/v3으로 저장했습니다/u)).toBeVisible());
    const call = request.mock.calls.find(([endpoint]) =>
      (endpoint as { path: string }).path.endsWith("/versions"),
    );
    const body = (
      call?.[1] as { body: { base_version: number; note: string; deploy: boolean; graph: typeof graph } }
    ).body;
    expect(body.base_version).toBe(2);
    expect(body.deploy).toBe(false);
    expect(body.note).toBe("모델 교체");
    expect(body.graph.elements.find((element) => element.id === "premium")?.properties).toMatchObject({
      model: "bigger-model",
    });
  });

  it("blocks saving while the server reports errors and marks the element", async () => {
    mockApi({
      "GET /admin/routing/dynamic-routes/{id}": () => detail,
      "POST /admin/routing/dynamic-routes/validate": () => ({
        valid: false,
        graph,
        validation: {
          errors: [{ element_id: "cheap", code: "model_missing", message: "호출할 모델이 비어 있습니다." }],
          warnings: [],
        },
      }),
    });
    renderAt("/routing/dynamic/drt_1");
    fireEvent.click(await screen.findByRole("button", { name: /모델 premium/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "모델" }), { target: { value: "x" } });
    expect(await screen.findByText(/오류 1개/u)).toBeVisible();
    expect(screen.getByRole("button", { name: /모델 cheap.*오류 있음/u })).toBeVisible();
    expect(screen.getByRole("button", { name: "새 버전으로 저장" })).toBeDisabled();
  });

  it("simulates a fallback and shows the path it took", async () => {
    const request = mockApi({
      "GET /admin/routing/dynamic-routes/{id}": () => detail,
      "POST /admin/routing/dynamic-routes/validate": () => valid,
      "POST /admin/routing/dynamic-routes/simulate": () => ({
        result: {
          steps: [
            { id: "start", type: "start", outcome: "next" },
            { id: "plan", type: "conditional", outcome: "false" },
            { id: "premium", type: "model", outcome: "failed", detail: "simulated" },
            { id: "cheap", type: "model", outcome: "success" },
            { id: "end", type: "end", outcome: "end" },
          ],
          path: "start>plan:false>premium:failed>cheap:success>end",
          outcome: "success",
          final_element_id: "cheap",
          final_model: "small-model",
          attempts: 2,
          fallbacks: 1,
        },
        distribution: [
          {
            final_element_id: "cheap",
            final_model: "small-model",
            outcome: "success",
            count: 1000,
            share: 1,
          },
        ],
        samples: 1000,
        validation: { errors: [], warnings: [] },
      }),
    });
    renderAt("/routing/dynamic/drt_1");
    fireEvent.click(await screen.findByRole("tab", { name: "시뮬레이션" }));
    fireEvent.click(screen.getByLabelText(/premium \(big-model\)/u));
    fireEvent.click(screen.getByRole("button", { name: "시뮬레이션 실행" }));
    expect(
      await screen.findByText(/X-Dynamic-Route-Path: start>plan:false>premium:failed>cheap:success>end/u),
    ).toBeVisible();
    const call = request.mock.calls.find(([endpoint]) =>
      (endpoint as { path: string }).path.endsWith("/simulate"),
    );
    expect((call?.[1] as { body: { failing: string[]; route_id: string } }).body).toMatchObject({
      failing: ["premium"],
      route_id: "drt_1",
    });
  });

  it("rolls back only with a reason and against the deployed version it showed", async () => {
    const request = mockApi({
      "GET /admin/routing/dynamic-routes/{id}": () => ({
        ...detail,
        route: { ...route, deployed_version: 2, state: "live" },
      }),
      "POST /admin/routing/dynamic-routes/validate": () => valid,
      "POST /admin/routing/dynamic-routes/{id}/deploy": () => ({ route: { ...route, deployed_version: 1 } }),
    });
    renderAt("/routing/dynamic/drt_1");
    fireEvent.click(await screen.findByRole("tab", { name: "버전·배포" }));
    fireEvent.click(screen.getByRole("button", { name: /이 버전으로 롤백/u }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "롤백" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "v2 오류율 증가" } });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText("v1으로 롤백했습니다.")).toBeVisible());
    const call = request.mock.calls.find(([endpoint]) =>
      (endpoint as { path: string }).path.endsWith("/deploy"),
    );
    expect((call?.[1] as { body: unknown }).body).toEqual({
      version: 1,
      expected_deployed_version: 2,
      reason: "v2 오류율 증가",
    });
  });
});
