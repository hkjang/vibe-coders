import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PreviewTab } from "./PreviewTab";
import { routingCostGuardQueryKey } from "./routing-shared";
import { formatCostGuardThreshold } from "@/shared/utils/cost-guard";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});

describe("라우팅 미리보기의 확인된 비용 보호 요약", () => {
  it("소수 임계값은 반올림하지 않고 숫자 의미를 유지한다", () => {
    for (const value of [0, 0.000125, 1e-25, 1e25, 123.45, Number.MIN_VALUE]) {
      const shown = formatCostGuardThreshold(value);
      expect(shown).toBe(`${value}원`);
      expect(Number(shown.slice(0, -1))).toBe(value);
    }
    for (const value of [NaN, Infinity, -1]) expect(formatCostGuardThreshold(value)).toBe("확인되지 않음");
  });
  it.each([false, true])("확인된 enabled=%s·임계값0은 제한 없음으로 표시한다", async (enabled) => {
    const api = mockApi({ "GET /admin/cost": () => ({ enabled, threshold_krw: 0 }) });
    renderScreen(<PreviewTab canPredict={false} />);
    expect(await screen.findByText("제한 없음")).toBeVisible();
    expect(screen.getByText("0원")).toBeVisible();
    expect(screen.queryByText("사용 중")).not.toBeInTheDocument();
    expect(api.calls.every(({ key }) => key === "GET /admin/cost")).toBe(true);
  });
  it("양의 작은 임계값과 무효화된 상태를 구별한다", async () => {
    mockApi({ "GET /admin/cost": () => ({ enabled: true, threshold_krw: 0.000125 }) });
    const { client } = renderScreen(<PreviewTab canPredict={false} />);
    expect(await screen.findByText("0.000125원")).toBeVisible();
    expect(screen.getByText("사용 중")).toBeVisible();
    await act(async () =>
      client.invalidateQueries({ queryKey: routingCostGuardQueryKey, exact: true, refetchType: "none" }),
    );
    expect(screen.getByText("설정 미확인")).toBeVisible();
    expect(screen.queryByText("사용 중")).not.toBeInTheDocument();
    expect(screen.queryByText("0.000125원")).not.toBeInTheDocument();
  });
  it("조회 중과 이전 성공 뒤 오류를 중지·0원으로 위장하지 않고 재시도한다", async () => {
    const user = userEvent.setup();
    let release!: (value: unknown) => void;
    let response: unknown = new Promise((resolve) => {
      release = resolve;
    });
    let fail = false;
    const api = mockApi({
      "GET /admin/cost": () => {
        if (fail) throw apiFailure("failed", 503, "req_routing_cost");
        return response;
      },
    });
    renderScreen(<PreviewTab canPredict={false} />);
    expect(screen.getByText("설정 미확인")).toBeVisible();
    expect(screen.queryByText("제한 없음")).not.toBeInTheDocument();
    await act(async () => release({ enabled: true, threshold_krw: 0.125 }));
    expect(await screen.findByText("0.125원")).toBeVisible();
    fail = true;
    await user.click(screen.getByRole("button", { name: "비용 보호 설정 새로고침" }));
    expect(await screen.findByText(/req_routing_cost/u)).toBeVisible();
    expect(screen.getByText("설정 미확인")).toBeVisible();
    expect(screen.queryByText("사용 중")).not.toBeInTheDocument();
    expect(screen.queryByText("0.125원")).not.toBeInTheDocument();
    fail = false;
    response = { enabled: false, threshold_krw: 0 };
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.getByText("제한 없음")).toBeVisible());
    expect(api.calls.every(({ key }) => key === "GET /admin/cost")).toBe(true);
  });
});
