import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavigate } from "react-router";
import { OverviewTab } from "./OverviewTab";
import { AllocationTab } from "./AllocationTab";
import { ChargebackTab } from "./ChargebackTab";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { downloadCsv, downloadText } from "@/shared/utils/csv";
import type * as CsvUtils from "@/shared/utils/csv";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ id: "account_a", read: true, permitted: true, mounted: true }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        user: { id: runtime.id },
        scopes: runtime.read ? ["admin:read", "costs:read"] : ["costs:read"],
      }),
  };
});
vi.mock("@/shared/utils/csv", async (original) => ({
  ...(await original<typeof CsvUtils>()),
  downloadText: vi.fn(),
  downloadCsv: vi.fn(),
}));
beforeEach(() => {
  Object.assign(runtime, { id: "account_a", read: true, permitted: true, mounted: true });
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());
const row = { key: "공개 비용 항목", requests: 2, tokens: 10, cost_krw: 30, error_requests: 1 };
const allocation = { dimension: "project", rows: [row] };
const billing = {
  total_cost_krw: 30,
  total_requests: 2,
  by_cost_center: [row],
  by_model: [],
  budgets: [],
  migration_candidates: [],
  estimated_savings_krw: 0,
};
const pack = {
  month: "2026-10",
  dimensions: [{ dimension: "project", rows: [row], total_cost_krw: 30, total_requests: 2 }],
};
const types = ["overview", "allocation", "chargeback"] as const;
type Tab = (typeof types)[number];
const endpoint = {
  overview: "GET /billing/dashboard",
  allocation: "GET /admin/cost/allocation",
  chargeback: "GET /admin/cost/chargeback-pack",
};
const values = { overview: billing, allocation, chargeback: pack };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(tab: Tab, handlers: Record<string, ApiHandler> = {}, query = "month=2026-10") {
  const api = mockApi({ [endpoint[tab]]: () => values[tab], ...handlers });
  let refresh = () => {};
  let navigate: (path: string) => void = () => {};
  function Harness() {
    const [, update] = useReducer((value: number) => value + 1, 0);
    refresh = update;
    navigate = useNavigate();
    const Component = { overview: OverviewTab, allocation: AllocationTab, chargeback: ChargebackTab }[tab];
    return (
      <FeatureAccessContext.Provider
        value={{
          featureId: "finops.overview",
          permitted: runtime.permitted,
          status: "preview",
          readOnly: true,
        }}
      >
        {runtime.mounted ? <Component /> : null}
      </FeatureAccessContext.Provider>
    );
  }
  return {
    ...renderScreen(<Harness />, { path: "/finops/*", route: `/finops?${query}` }),
    api,
    refresh: () => act(refresh),
    navigate: (query: string) => act(() => navigate(`/finops?${query}`)),
  };
}
describe("비용 조회의 소유 계정과 조건", () => {
  it.each(types)("%s는 비용 권한만으로 관리자 조회를 하지 않는다", (tab) => {
    runtime.read = false;
    const fixture = setup(tab);
    expect(screen.getByRole("alert")).toHaveTextContent("admin:read");
    expect(fixture.api.calls).toHaveLength(0);
  });
  it.each(types)("%s 최초 오류는 정상 빈 상태가 아니다", async (tab) => {
    setup(tab, {
      [endpoint[tab]]: () => {
        throw apiFailure("fixture", 500);
      },
    });
    await screen.findAllByRole("alert");
    for (const text of [
      "비용센터별 비용이 없습니다.",
      "모델별 비용이 없습니다.",
      "등록된 예산이 없습니다.",
      "배부할 비용이 없습니다.",
    ])
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    expect(screen.queryByText("공개 비용 항목")).not.toBeInTheDocument();
  });
  it.each(types)("%s 갱신 권한 거부는 데이터를 제거하고 재확인한다", async (tab) => {
    let denied = false;
    const fixture = setup(tab, {
      [endpoint[tab]]: () => {
        if (denied) throw apiFailure("fixture", 403);
        return values[tab];
      },
    });
    await screen.findAllByText("공개 비용 항목");
    denied = true;
    await act(async () => {
      await fixture.client.invalidateQueries({ queryKey: ["finops"] });
    });
    await screen.findByText("비용 조회 권한을 다시 확인하세요.");
    expect(screen.queryByText("공개 비용 항목")).not.toBeInTheDocument();
    expect(fixture.client.getQueryCache().getAll()).toHaveLength(0);
    denied = false;
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findAllByText("공개 비용 항목")).not.toHaveLength(0);
  });
  it.each(
    types.flatMap((tab) => ["account", "read", "feature", "unmount"].map((change) => ({ tab, change }))),
  )("$tab/$change 이후 늦은 응답을 표시하지 않는다", async ({ tab, change }) => {
    const pending = deferred<unknown>();
    let calls = 0;
    const fixture = setup(tab, {
      [endpoint[tab]]: () => (++calls === 1 ? pending.promise : new Promise(() => {})),
    });
    await waitFor(() => expect(calls).toBe(1));
    if (change === "account") runtime.id = "account_b";
    if (change === "read") runtime.read = false;
    if (change === "feature") runtime.permitted = false;
    if (change === "unmount") runtime.mounted = false;
    fixture.refresh();
    await act(async () => pending.resolve(values[tab]));
    expect(screen.queryByText("공개 비용 항목")).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        fixture.client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("공개 비용 항목");
  });
  it("배부 조건 변경 중 이전 결과를 새 조건으로 내보내지 않는다", async () => {
    const pending = deferred<unknown>();
    const fixture = setup("allocation", {
      [endpoint.allocation]: ({ query }) =>
        (query as { dimension: string }).dimension === "model" ? pending.promise : allocation,
    });
    await screen.findAllByText("공개 비용 항목");
    await userEvent.selectOptions(screen.getByLabelText("배부 기준"), "model");
    expect(screen.queryByText("공개 비용 항목")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
    await act(async () => pending.resolve({ ...allocation, rows: [{ ...row, key: "변경된 모델" }] }));
    await screen.findAllByText("변경된 모델");
    await userEvent.click(screen.getByRole("button", { name: "CSV 내보내기" }));
    expect(downloadCsv).toHaveBeenCalledWith(
      expect.stringContaining("model"),
      expect.stringContaining("변경된 모델"),
    );
    expect(fixture.api.calls).toHaveLength(2);
  });
});

describe("정산 CSV 내보내기", () => {
  it("조회에 적용하지 않은 월 입력으로 내보내지 않는다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setup("chargeback");
    await screen.findAllByText("공개 비용 항목");
    await userEvent.clear(screen.getByLabelText("정산 월"));
    await userEvent.type(screen.getByLabelText("정산 월"), "2026-09");
    expect(screen.getByRole("button", { name: "CSV 다운로드" })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each(["account", "read", "feature", "unmount", "month"])(
    "%s 변경 후 늦은 CSV 본문을 저장하지 않는다",
    async (change) => {
      const pending = deferred<string>();
      const response = new Response("", { headers: { "Content-Type": "text/csv" } });
      vi.spyOn(response, "text").mockReturnValue(pending.promise);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
      const fixture = setup("chargeback");
      await screen.findAllByText("공개 비용 항목");
      await userEvent.click(screen.getByRole("button", { name: "CSV 다운로드" }));
      await waitFor(() => expect(response.text).toHaveBeenCalledTimes(1));
      if (change === "account") runtime.id = "account_b";
      if (change === "read") runtime.read = false;
      if (change === "feature") runtime.permitted = false;
      if (change === "unmount") runtime.mounted = false;
      if (change === "month") fixture.navigate("month=2026-09");
      else fixture.refresh();
      await act(async () => pending.resolve("fixture-csv"));
      expect(downloadText).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect((fetchSpy.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
      expect(screen.queryByText("CSV 다운로드 실패")).not.toBeInTheDocument();
    },
  );
  it("같은 화면의 중복 다운로드를 막고 현재 월 파일을 한 번 저장한다", async () => {
    const pending = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
    setup("chargeback");
    await screen.findAllByText("공개 비용 항목");
    const button = screen.getByRole("button", { name: "CSV 다운로드" });
    await userEvent.dblClick(button);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await act(async () =>
      pending.resolve(new Response("fixture-csv", { headers: { "Content-Type": "text/csv" } })),
    );
    expect(downloadText).toHaveBeenCalledExactlyOnceWith(
      "chargeback-2026-10.csv",
      "fixture-csv",
      "text/csv;charset=utf-8",
    );
  });
  it.each([401, 403])("CSV %i는 자동 재전송 없이 이전 정산 데이터를 숨긴다", async (status) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fixture", { status }));
    setup("chargeback");
    await screen.findAllByText("공개 비용 항목");
    await userEvent.click(screen.getByRole("button", { name: "CSV 다운로드" }));
    await screen.findByText("비용 조회 권한을 다시 확인하세요.");
    expect(screen.queryByText("공개 비용 항목")).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(downloadText).not.toHaveBeenCalled();
  });
  it("CSV 일반 오류는 요청 ID를 표시하고 다음 시도를 허용한다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("fixture", { status: 500, headers: { "X-Request-ID": "csv-request" } }),
    );
    setup("chargeback");
    await screen.findAllByText("공개 비용 항목");
    await userEvent.click(screen.getByRole("button", { name: "CSV 다운로드" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("csv-request");
    expect(screen.getByRole("button", { name: "CSV 다운로드" })).toBeEnabled();
    expect(downloadText).not.toHaveBeenCalled();
  });
  it("잘못된 URL 월은 조회·내보내기하지 않고 수정 후 복구한다", async () => {
    const fixture = setup("chargeback", {}, "month=2026-13");
    expect(screen.getByText("YYYY-MM 형식으로 입력하세요.")).toBeInTheDocument();
    expect(fixture.api.calls).toHaveLength(0);
    expect(screen.getByRole("button", { name: "CSV 다운로드" })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("정산 월"));
    await userEvent.type(screen.getByLabelText("정산 월"), "2026-09");
    await userEvent.click(screen.getByRole("button", { name: "조회" }));
    expect(await screen.findAllByText("공개 비용 항목")).not.toHaveLength(0);
    expect(fixture.api.calls[0]?.options.query).toEqual({ month: "2026-09" });
  });
});
