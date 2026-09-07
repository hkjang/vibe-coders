import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FinopsPage } from "@/features/finops/overview/FinopsPage";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "costs:read"] as string[] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

const budgetStatus = {
  budget: {
    id: "bud_1",
    scope: "team",
    scope_value: "platform",
    monthly_krw: 1_000_000,
    note: "플랫폼 팀 월 예산",
    created_at: "2026-08-01T00:00:00Z",
  },
  spent_krw: 880_000,
  burn_ratio: 0.88,
  projected_krw: 1_240_000,
  projected_ratio: 1.24,
  days_elapsed: 7,
  days_in_month: 30,
  exhaustion_date: "2026-09-24",
  on_track: false,
};

const billingResponse = {
  since: "2026-08-08T00:00:00Z",
  total_cost_krw: 2_450_000,
  total_requests: 128_400,
  by_cost_center: [
    { key: "CC-100", requests: 40_000, tokens: 9_000_000, cost_krw: 900_000, error_requests: 12 },
  ],
  by_model: [
    { key: "gpt-4.1", requests: 88_400, tokens: 21_000_000, cost_krw: 1_550_000, error_requests: 30 },
  ],
  budgets: [budgetStatus],
  migration_candidates: [
    {
      fingerprint: "fp_1",
      task_type: "coding",
      requests: 320,
      current_model: "gpt-4.1",
      recommended_model: "gpt-4.1-mini",
      current_avg_cost_krw: 42.5,
      recommended_avg_cost_krw: 9.1,
      current_success_rate: 0.93,
      recommended_success_rate: 0.95,
      estimated_savings_krw: 10_688,
    },
  ],
  estimated_savings_krw: 10_688,
};

const allocationResponse = {
  dimension: "project",
  dimensions: ["project", "model"],
  since: "2026-08-08T00:00:00Z",
  rows: [
    { key: "atlas", requests: 12_000, tokens: 3_000_000, cost_krw: 420_000, error_requests: 8 },
    { key: "", requests: 900, tokens: 120_000, cost_krw: 15_000, error_requests: 0 },
  ],
};

const chargebackResponse = {
  month: "2026-08",
  period_start: "2026-07-31T15:00:00Z",
  period_end: "2026-08-31T15:00:00Z",
  generated_at: "2026-09-01T00:10:00Z",
  note: "월별 비용 배부 패키지입니다.",
  dimensions: [
    {
      dimension: "cost_center",
      total_cost_krw: 900_000,
      total_requests: 40_000,
      rows: [{ key: "CC-100", requests: 40_000, tokens: 9_000_000, cost_krw: 900_000, error_requests: 12 }],
    },
  ],
};

const anomaliesResponse = {
  budget_projections: [budgetStatus],
  over_projected: [budgetStatus],
  session_loops: [
    {
      session_id: "sess_loop_1",
      api_key_id: "key_1",
      prompt_fingerprint: "fp_loop",
      repeats: 42,
      cost_krw: 31_000,
      tokens: 900_000,
      first_seen: "2026-09-07T00:00:00Z",
      last_seen: "2026-09-07T02:00:00Z",
    },
  ],
  window_since: "2026-09-06T20:00:00Z",
  projected_ratio: 1,
};

const alertsResponse = {
  alerts: [
    {
      scope: "team",
      scope_value: "platform",
      monthly_krw: 1_000_000,
      spent_krw: 880_000,
      burn_ratio: 0.88,
      projected_ratio: 1.24,
      projected_krw: 1_240_000,
      exhaustion_date: "2026-09-24",
      severity: "critical",
    },
  ],
  warn: 1,
  critical: 1,
  thresholds: { warn: 0.8, critical: 1 },
};

function mockAllEndpoints(overrides: Readonly<Record<string, ApiHandler>> = {}) {
  return mockApi({
    "GET /billing/dashboard": () => billingResponse,
    "GET /admin/cost/allocation": () => allocationResponse,
    "GET /admin/cost/chargeback-pack": () => chargebackResponse,
    "GET /admin/cost/anomalies": () => anomaliesResponse,
    "GET /admin/budgets/alerts": () => alertsResponse,
    ...overrides,
  });
}

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "costs:read"];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:test" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function render(route = "/finops") {
  return renderScreen(<FinopsPage />, { route, path: "/finops/*" });
}

describe("FinopsPage", () => {
  it("비용 요약과 비용센터·모델별 비용을 보여준다", async () => {
    mockAllEndpoints();
    render();

    expect(await screen.findByText("₩2,450,000")).toBeInTheDocument();
    expect(screen.getByText("128,400")).toBeInTheDocument();
    expect(screen.getByText("CC-100")).toBeInTheDocument();
    expect(screen.getByText(/₩1,550,000/u)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /gpt-4.1-mini/u })).toHaveTextContent("₩10,688");
  });

  it("예산이 없으면 어디서 만드는지 안내한다", async () => {
    mockAllEndpoints({
      "GET /billing/dashboard": () => ({ ...billingResponse, budgets: [] }),
    });
    render();

    expect(await screen.findByText("등록된 예산이 없습니다.")).toBeInTheDocument();
  });

  it("조회에 실패하면 요청 ID와 함께 오류를 알린다", async () => {
    mockAllEndpoints({
      "GET /billing/dashboard": () => {
        throw apiFailure("billing failed", 500, "req_finops_1");
      },
    });
    render();

    const alerts = await screen.findAllByRole("alert");
    const notice = alerts.find((element) =>
      element.textContent?.includes("비용 대시보드을(를) 불러오지 못했습니다."),
    );
    expect(notice).toBeDefined();
    expect(notice).toHaveTextContent("요청 ID: req_finops_1");
  });

  it("URL 쿼리에서 탭과 필터를 복원해 서버에 전달한다", async () => {
    const api = mockAllEndpoints();
    render("/finops?tab=allocation&dimension=model&window=7d");

    expect(await screen.findByRole("tab", { name: "비용 배부", selected: true })).toBeInTheDocument();
    expect(screen.getByLabelText("배부 기준")).toHaveValue("model");
    expect(screen.getByLabelText("조회 기간")).toHaveValue("7d");
    await waitFor(() =>
      expect(api.calls.find((call) => call.key === "GET /admin/cost/allocation")?.options.query).toEqual({
        dimension: "model",
        window: "7d",
        limit: 100,
      }),
    );
  });

  it("배부 팩 CSV는 서버 내보내기를 인증 헤더와 함께 호출한다", async () => {
    mockAllEndpoints();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("month,dimension,key\n", { status: 200 }));
    render("/finops?tab=chargeback&month=2026-08");

    await screen.findByRole("table", { name: "비용센터 비용 배부" });
    await userEvent.click(screen.getByRole("button", { name: /CSV 다운로드/u }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/admin/cost/chargeback-pack?format=csv&month=2026-08");
    expect(new Headers(init.headers).get("X-Vibe-UI")).toBe("app");
  });

  it("정산 월 형식이 잘못되면 조회하지 않고 형식을 안내한다", async () => {
    const api = mockAllEndpoints();
    render("/finops?tab=chargeback");

    const input = await screen.findByLabelText(/정산 월/u);
    await userEvent.clear(input);
    await userEvent.type(input, "2026-13");
    await userEvent.click(screen.getByRole("button", { name: "조회" }));

    expect(await screen.findByText("YYYY-MM 형식으로 입력하세요.")).toBeInTheDocument();
    expect(api.calls.filter((call) => call.key === "GET /admin/cost/chargeback-pack").length).toBeGreaterThan(
      0,
    );
  });

  it("예산 편집은 이 화면에서 할 수 없다고 알리고 담당 화면으로 보낸다", async () => {
    mockAllEndpoints();
    render("/finops?tab=budget");

    expect(await screen.findByRole("link", { name: "사용자·팀" })).toHaveAttribute("href", "/access/users");
    expect(await screen.findByText("42회 반복")).toBeInTheDocument();
    const projections = screen.getAllByRole("listitem");
    expect(projections.some((item) => item.textContent?.includes("월말 예상"))).toBe(true);
  });

  it("읽기 전용 화면임을 표시한다", async () => {
    authRuntime.scopes = ["costs:read"];
    mockAllEndpoints();
    render();

    expect(await screen.findByText("읽기 전용")).toBeInTheDocument();
  });

  it("접근성 위반이 없다", async () => {
    mockAllEndpoints();
    const { container } = render();

    await screen.findByText("₩2,450,000");
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("예산 탭도 접근성 위반이 없다", async () => {
    mockAllEndpoints();
    const { container } = render("/finops?tab=budget");

    await screen.findByText("42회 반복");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
