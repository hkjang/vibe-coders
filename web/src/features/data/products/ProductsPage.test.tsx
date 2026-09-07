import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProductsPage } from "@/features/data/products/ProductsPage";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] as string[] }));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

vi.mock("sonner", () => ({ toast: { success: toastSpy.success, error: toastSpy.error } }));

const draftProduct = {
  id: "dprod_1",
  product_key: "weekly_cost",
  name_ko: "주간 비용 리포트",
  description: "팀별 주간 비용 요약",
  source_type: "saved_report",
  source_ref: "rep_42",
  owner: "platform",
  allowed_teams: ["platform"],
  sensitivity: "internal",
  status: "draft",
  version: 1,
  updated_by: "operator@example.com",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-09-05T09:00:00Z",
};

const publishedProduct = {
  ...draftProduct,
  id: "dprod_2",
  product_key: "model_usage",
  name_ko: "모델 사용 현황",
  source_type: "metric",
  source_ref: "daily_cost",
  allowed_teams: [],
  sensitivity: "restricted",
  status: "published",
  version: 3,
};

const requestsResponse = {
  requests: [
    {
      id: "dpreq_1",
      product_key: "model_usage",
      user_id: "analyst@example.com",
      team: "growth",
      status: "pending",
      reason: "주간 리포트 작성",
      decided_by: "",
      created_at: "2026-09-06T01:00:00Z",
    },
  ],
};

const candidatesResponse = {
  since: "2026-08-08T00:00:00Z",
  note: "반복 Text2SQL 질문을 데이터 상품 후보로 분류합니다(원문 SQL 미노출).",
  candidates: [
    {
      question: "지난주 팀별 비용은?",
      count: 12,
      last_seen: "2026-09-06T05:00:00Z",
      recommended_product: "팀별 주간 비용",
    },
  ],
};

function mockAllEndpoints(overrides: Readonly<Record<string, ApiHandler>> = {}) {
  return mockApi({
    "GET /admin/data-products": () => ({ products: [draftProduct, publishedProduct] }),
    "POST /admin/data-products": () => ({ product_key: "weekly_cost", ok: true }),
    "DELETE /admin/data-products": () => ({ ok: true }),
    "GET /admin/data-products/requests": () => requestsResponse,
    "POST /admin/data-products/requests": () => ({ id: "dpreq_1", status: "approved" }),
    "GET /admin/data-products/candidates": () => candidatesResponse,
    ...overrides,
  });
}

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "admin:write"];
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function render(route = "/data/products") {
  return renderScreen(<ProductsPage />, { route, path: "/data/products" });
}

describe("ProductsPage", () => {
  it("데이터 상품 목록과 상태를 보여준다", async () => {
    mockAllEndpoints();
    render();

    const row = await screen.findByRole("row", { name: /weekly_cost/u });
    const table = screen.getByRole("table", { name: "등록된 데이터 상품" });
    expect(within(row).getByText("주간 비용 리포트")).toBeInTheDocument();
    expect(within(row).getByText("초안")).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: /model_usage/u })).toHaveTextContent("게시됨");
    expect(within(table).getByRole("row", { name: /model_usage/u })).toHaveTextContent("전체 팀");
  });

  it("등록된 상품이 없으면 만드는 방법을 안내한다", async () => {
    mockAllEndpoints({ "GET /admin/data-products": () => ({ products: [] }) });
    render();

    expect(
      await screen.findByText("등록된 데이터 상품이 없습니다. ‘상품 등록’으로 첫 상품을 만드세요."),
    ).toBeInTheDocument();
  });

  it("조회에 실패하면 요청 ID와 함께 오류를 알린다", async () => {
    mockAllEndpoints({
      "GET /admin/data-products": () => {
        throw apiFailure("list failed", 500, "req_dp_1");
      },
    });
    render();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("데이터 상품을(를) 불러오지 못했습니다.");
    expect(alert).toHaveTextContent("요청 ID: req_dp_1");
  });

  it("쓰기 권한이 없으면 등록과 행 작업을 비활성화한다", async () => {
    authRuntime.scopes = ["admin:read"];
    mockAllEndpoints();
    render();

    const createButton = await screen.findByRole("button", { name: /상품 등록/u });
    expect(createButton).toBeDisabled();
    expect(createButton).toHaveAttribute("title", expect.stringContaining("admin:write"));
    expect(await screen.findByRole("button", { name: "weekly_cost 삭제" })).toBeDisabled();
  });

  it("게시를 확인하면 상태 변경 본문을 보내고 결과를 알린다", async () => {
    const api = mockAllEndpoints();
    render();

    await userEvent.click(await screen.findByRole("button", { name: "weekly_cost 게시" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "게시" }));

    await waitFor(() => expect(api.bodies("POST /admin/data-products")).toHaveLength(1));
    expect(api.bodies("POST /admin/data-products")[0]).toMatchObject({
      id: "dprod_1",
      product_key: "weekly_cost",
      status: "published",
      allowed_teams: ["platform"],
    });
    await waitFor(() =>
      expect(toastSpy.success).toHaveBeenCalledWith("weekly_cost 상태를 게시됨(으)로 변경했습니다."),
    );
  });

  it("접근 요청을 승인하면 결정 본문을 보낸다", async () => {
    const api = mockAllEndpoints();
    render("/data/products?tab=requests");

    await userEvent.click(await screen.findByRole("button", { name: "model_usage 요청 승인" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "승인" }));

    await waitFor(() => expect(api.bodies("POST /admin/data-products/requests")).toHaveLength(1));
    expect(api.bodies("POST /admin/data-products/requests")[0]).toEqual({
      id: "dpreq_1",
      action: "approve",
    });
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("접근 요청을 승인했습니다."));
  });

  it("URL 쿼리에서 탭과 필터를 복원해 서버에 전달한다", async () => {
    const api = mockAllEndpoints();
    render("/data/products?tab=candidates&window=7d&min_count=5&status=published");

    expect(await screen.findByRole("tab", { name: "발행 후보", selected: true })).toBeInTheDocument();
    await screen.findByRole("table", { name: "데이터 상품 발행 후보" });
    expect(screen.getByLabelText("조회 구간")).toHaveValue("7d");
    expect(
      api.calls.find((call) => call.key === "GET /admin/data-products/candidates")?.options.query,
    ).toEqual({ window: "7d", min_count: 5 });
    expect(api.calls.find((call) => call.key === "GET /admin/data-products")?.options.query).toEqual({
      status: "published",
    });
  });

  it("접근성 위반이 없다", async () => {
    mockAllEndpoints();
    const { container } = render();

    await screen.findByRole("table", { name: "등록된 데이터 상품" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
