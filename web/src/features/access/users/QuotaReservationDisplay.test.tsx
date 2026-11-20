import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { adminQuotasSchema } from "@/shared/api/domains/access.schemas";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { QuotasTab } from "./QuotasTab";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ role: "admin", scopes: ["admin:read"] }) };
});

const quota = {
  id: "reservation-display",
  scope: "global",
  scope_value: "*",
  period: "daily",
  enabled: true,
  token_limit: 100,
  krw_limit: 500,
};
const settled = {
  quota,
  tokens: 6,
  cost_krw: 6,
  token_remain_ratio: 0.94,
  krw_remain_ratio: 0.988,
  period_start: "2026-11-20T00:00:00Z",
  period_end: "2026-11-21T00:00:00Z",
};
function setup(initial: Record<string, unknown>) {
  const state = { usage: initial };
  const api = mockApi({
    "GET /admin/quotas": () => adminQuotasSchema.parse({ quotas: [state.usage.quota], usage: [state.usage] }),
    "GET /admin/budgets": () => ({ budgets: [] }),
    "GET /admin/budgets/projection": () => ({ teams: [], exceeding: 0 }),
  });
  const view = renderScreen(
    <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: true }}>
      <QuotasTab canWrite={false} writeDeniedReason="읽기 전용입니다." />
    </FeatureAccessContext.Provider>,
  );
  return { state, api, ...view };
}
async function cells() {
  const table = await screen.findByRole("table", { name: "할당량과 사용량" });
  const row = within(table).getAllByRole("row")[1];
  if (!row) throw new Error("할당량 데이터 행이 필요합니다.");
  const data = within(row).getAllByRole("cell");
  const tokens = data[4],
    cost = data[5];
  if (!tokens || !cost) throw new Error("토큰과 비용 열이 필요합니다.");
  return { table: within(table), tokens: within(tokens), cost: within(cost) };
}

describe("진행 중 요청의 할당량 표시", () => {
  it("확정 사용량과 예약량을 합산하고 진행 중인 부분을 별도로 설명한다", async () => {
    const { api } = setup({
      ...settled,
      tokens: 12,
      cost_krw: 4,
      reserved_tokens: 26,
      reserved_cost_krw: 26,
      token_remain_ratio: 0.62,
      krw_remain_ratio: 0.94,
    });
    const { table, tokens, cost } = await cells();
    expect(tokens.getByText("38 / 100", { exact: true })).toBeVisible();
    expect(cost.getByText("₩30 / ₩500", { exact: true })).toBeVisible();
    expect(tokens.getByText("진행 중 26 토큰 포함", { exact: true })).toBeVisible();
    expect(cost.getByText("진행 중 ₩26 포함", { exact: true })).toBeVisible();
    expect(tokens.getByRole("meter")).toHaveAttribute("aria-valuenow", "38");
    expect(cost.getByRole("meter")).toHaveAttribute("aria-valuenow", "6");
    for (const button of table.getAllByRole("button")) expect(button).toBeDisabled();
    expect(api.calls.filter((call) => !call.key.startsWith("GET "))).toEqual([]);
  });

  it("완료 후 재조회하면 예약 안내가 없어지고 확정 사용량으로 바뀐다", async () => {
    const { state, client } = setup({ ...settled, reserved_tokens: 20, reserved_cost_krw: 10 });
    await screen.findByText("진행 중 20 토큰 포함", { exact: true });
    state.usage = { ...settled, reserved_tokens: 0, reserved_cost_krw: 0 };
    await act(async () => {
      await client.invalidateQueries();
    });
    const { tokens, cost } = await cells();
    await waitFor(() => expect(tokens.queryByText(/진행 중/)).not.toBeInTheDocument());
    expect(cost.queryByText(/진행 중/)).not.toBeInTheDocument();
    expect(tokens.getByText("6 / 100", { exact: true })).toBeVisible();
    expect(cost.getByText("₩6 / ₩500", { exact: true })).toBeVisible();
  });

  it.each([{}, { reserved_tokens: 0, reserved_cost_krw: 0 }])(
    "예약 필드가 없거나 0이면 기존 확정 사용량과 무제한 상태를 유지한다: %j",
    async (reservation) => {
      setup({
        ...settled,
        ...reservation,
        quota: { ...quota, token_limit: 0, krw_limit: 0 },
        token_remain_ratio: -1,
        krw_remain_ratio: -1,
      });
      const { table, tokens, cost } = await cells();
      expect(tokens.getByText("6", { exact: true })).toBeVisible();
      expect(cost.getByText("₩6", { exact: true })).toBeVisible();
      expect(table.getAllByText("한도 없음")).toHaveLength(2);
      expect(table.queryByRole("meter")).not.toBeInTheDocument();
      expect(table.queryByText(/진행 중/)).not.toBeInTheDocument();
    },
  );

  it("비용 예약만 있어도 비용 안내를 표시하고 토큰 예약을 만들어 표시하지 않는다", async () => {
    setup({ ...settled, reserved_tokens: 0, reserved_cost_krw: 0.25 });
    const { tokens, cost } = await cells();
    expect(tokens.queryByText(/진행 중/)).not.toBeInTheDocument();
    expect(cost.getByText("₩6.25 / ₩500", { exact: true })).toBeVisible();
    expect(cost.getByText("진행 중 ₩0.25 포함", { exact: true })).toBeVisible();
  });
});
