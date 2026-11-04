import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewTab } from "./OverviewTab";
import { finopsEndpoints } from "@/shared/api/domains/finops";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "costs:read"] }) };
});
afterEach(() => vi.restoreAllMocks());
const report = {
  since: "2026-10-01T00:00:00Z",
  totals_scope: "all_retained_requests",
  total_cost_krw: 231,
  total_requests: 22,
  estimated_savings_krw: 30,
  by_cost_center: [{ key: "공개 비용센터", cost_krw: 230, requests: 20 }],
  by_model: [{ key: "공개 모델", cost_krw: 230, requests: 20 }],
  budgets: [{ budget: { id: "public-budget", scope: "global" }, on_track: true }],
  migration_candidates: [{ current_model: "공개 전환 원본", estimated_savings_krw: 30 }],
  unavailable_sections: [] as string[],
};
function render() {
  return renderScreen(
    <FeatureAccessContext.Provider
      value={{ featureId: "finops.overview", permitted: true, readOnly: true, status: "preview" }}
    >
      <OverviewTab />
    </FeatureAccessContext.Provider>,
    { route: "/finops", path: "/finops" },
  );
}
function fixture(value: unknown) {
  return finopsEndpoints.billingDashboard.schema.parse(value);
}

describe("비용 집계 범위와 부분 실패", () => {
  it("차트 상위 합계를 전체 합계로 다시 계산하지 않는다", async () => {
    mockApi({ "GET /billing/dashboard": () => fixture(report) });
    render();
    expect(await screen.findByText("₩231")).toBeInTheDocument();
    expect(screen.getByText("22")).toBeInTheDocument();
    expect(screen.getByText("총 비용")).toBeInTheDocument();
    expect(screen.getByText(/보관 중인 전체 요청 기준/u)).toBeInTheDocument();
    expect(screen.getByText(/상위 10개 프롬프트 군집/u)).toBeInTheDocument();
    expect(screen.getByText(/선택한 조회 기간과 별개로 이번 달/u)).toBeInTheDocument();
  });
  it("이전 서버의 상위 모델 합계는 전체 합계라고 표시하지 않는다", async () => {
    mockApi({
      "GET /billing/dashboard": () =>
        fixture({ ...report, totals_scope: undefined, unavailable_sections: undefined }),
    });
    render();
    expect(await screen.findByText("상위 모델 비용 합계")).toBeInTheDocument();
    expect(screen.queryByText("총 비용")).not.toBeInTheDocument();
    expect(screen.getByText(/서버 업그레이드가 필요/u)).toBeInTheDocument();
  });
  it.each([
    ["by_cost_center", "비용센터별 비용", "공개 비용센터"],
    ["by_model", "모델별 비용", "공개 모델"],
    ["budgets", "예산 소진율", "등록된 예산이 없습니다."],
    ["migration_candidates", "모델 전환 후보", "공개 전환 원본"],
  ])("%s 실패를 빈 데이터나 부분 성공으로 표시하지 않는다", async (section, label, hidden) => {
    let failed = true;
    mockApi({
      "GET /billing/dashboard": () => fixture({ ...report, unavailable_sections: failed ? [section] : [] }),
    });
    render();
    expect(await screen.findByText(`${label} 조회에 실패했습니다.`)).toBeInTheDocument();
    expect(screen.queryByText(hidden)).not.toBeInTheDocument();
    expect(screen.getByText("₩231")).toBeInTheDocument();
    const stats = screen.getByRole("region", { name: "비용 요약" });
    if (section === "budgets" || section === "migration_candidates")
      expect(within(stats).getByText("—")).toBeInTheDocument();
    failed = false;
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("공개 전환 원본")).toBeInTheDocument();
    expect(screen.queryByText(`${label} 조회에 실패했습니다.`)).not.toBeInTheDocument();
  });
  it("모든 부가 조회 실패에도 확인된 전체 합계를 보존한다", async () => {
    mockApi({
      "GET /billing/dashboard": () =>
        fixture({
          ...report,
          unavailable_sections: ["by_cost_center", "by_model", "budgets", "migration_candidates"],
        }),
    });
    render();
    expect(await screen.findByText("모델별 비용 조회에 실패했습니다.")).toBeInTheDocument();
    expect(screen.getByText("₩231")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText(/비용이 없습니다/u)).not.toBeInTheDocument();
  });
  it("전체 집계 실패에서는 0건이나 0원 대신 미확인과 요청 ID를 표시한다", async () => {
    mockApi({
      "GET /billing/dashboard": () => {
        throw apiFailure("failed", 503, "public-billing-id");
      },
    });
    render();
    expect(await screen.findByText(/public-billing-id/u)).toBeInTheDocument();
    expect(screen.queryByText("₩0")).not.toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(4);
  });
  it("정상 빈 결과는 오류와 구분한다", async () => {
    mockApi({
      "GET /billing/dashboard": () =>
        fixture({
          ...report,
          total_cost_krw: 0,
          total_requests: 0,
          by_model: [],
          by_cost_center: [],
          budgets: [],
          migration_candidates: [],
          estimated_savings_krw: 0,
        }),
    });
    render();
    expect(await screen.findByText("모델별 비용이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("등록된 예산이 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText(/조회에 실패했습니다/u)).not.toBeInTheDocument();
  });
  it("오류 메타데이터 형식이 잘못되면 성공으로 정규화하지 않는다", () => {
    for (const total_cost_krw of [undefined, null, "invalid", Infinity]) {
      expect(() => fixture({ ...report, total_cost_krw })).toThrow();
    }
    for (const total_requests of [undefined, null, -1, 1.5]) {
      expect(() => fixture({ ...report, total_requests })).toThrow();
    }
    for (const unavailable_sections of [null, "budgets", ["private-error-detail"]]) {
      expect(() => fixture({ ...report, unavailable_sections })).toThrow();
    }
    expect(() => fixture({ ...report, totals_scope: "unknown" })).toThrow();
    expect(fixture({ ...report, by_model: null, unavailable_sections: ["by_model"] }).by_model).toEqual([]);
  });
});
