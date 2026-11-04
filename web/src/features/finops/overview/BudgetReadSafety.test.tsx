import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetTab } from "./BudgetTab";
import { BudgetManagementLink } from "./BudgetManagementLink";
import { budgetSeverityLabel, severityTone } from "./finops-shared";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({
  id: "operator_a",
  read: true,
  permitted: true,
  status: "preview",
  fallback: true,
  destination: "preview",
  destinationAllowed: true,
  mounted: true,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({
        user: { id: runtime.id },
        scopes: runtime.read ? ["admin:read", "costs:read"] : ["costs:read"],
        legacyFallback: runtime.fallback,
      });
      return {
        ...auth,
        features: auth.features.map((feature) =>
          feature.featureId === "access.users"
            ? { ...feature, status: runtime.destination, serverAvailable: runtime.destinationAllowed }
            : feature,
        ),
      };
    },
  };
});
beforeEach(() =>
  Object.assign(runtime, {
    id: "operator_a",
    read: true,
    permitted: true,
    status: "preview",
    fallback: true,
    destination: "preview",
    destinationAllowed: true,
    mounted: true,
  }),
);
const anomalies = { budget_projections: [], over_projected: [], session_loops: [] };
const alerts = {
  alerts: [
    { scope: "team", scope_value: "예산 소유 팀", severity: "critical", spent_krw: 100, monthly_krw: 50 },
  ],
  warn: 1,
  critical: 1,
};
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(handlers: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/cost/anomalies": () => anomalies,
    "GET /admin/budgets/alerts": () => alerts,
    ...handlers,
  });
  let refresh = () => {};
  function Harness() {
    const [, update] = useReducer((value: number) => value + 1, 0);
    refresh = update;
    return (
      <FeatureAccessContext.Provider
        value={{
          featureId: "finops.overview",
          permitted: runtime.permitted,
          readOnly: true,
          status: runtime.status as "preview",
        }}
      >
        {runtime.mounted ? <BudgetTab /> : null}
      </FeatureAccessContext.Provider>
    );
  }
  return {
    ...renderScreen(<Harness />, { route: "/finops?tab=budget", path: "/finops/*" }),
    api,
    refresh: () => act(refresh),
  };
}
describe("예산 조회 안전성", () => {
  it.each([
    ["critical", "위험", "danger"],
    ["warn", "경고", "warning"],
    ["warning", "경고", "warning"],
    ["ok", "정상", "success"],
    ["future-status", "상태 미확인", "info"],
  ])("서버 단계 %s를 한글과 구분되는 상태로 표시한다", (value, label, tone) => {
    expect(budgetSeverityLabel(value)).toBe(label);
    expect(severityTone(value)).toBe(tone);
  });
  it("요약에는 경고와 위험 예산을 모두 포함한다", async () => {
    setup();
    await screen.findByText("팀 · 예산 소유 팀");
    expect(screen.getByText("경고·위험 예산").closest("article")).toHaveTextContent("2");
  });
  it("조회 중에는 빈 상태와 성공 수치를 표시하지 않는다", async () => {
    const pending = deferred();
    setup({
      "GET /admin/cost/anomalies": () => pending.promise,
      "GET /admin/budgets/alerts": () => pending.promise,
    });
    expect(await screen.findByText("예산 경고를 불러오는 중입니다.")).toBeInTheDocument();
    expect(screen.queryByText("예산이 없습니다.")).not.toBeInTheDocument();
    expect(screen.queryByText("반복 호출이 없습니다.")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "예산 요약" })).getAllByText("—")).toHaveLength(4);
    await act(async () => pending.resolve({ ...anomalies, alerts: [], warn: 0 }));
    expect(await screen.findByText("예산이 없습니다.")).toBeInTheDocument();
    expect(await screen.findByText("예산 경고 항목이 없습니다.")).toBeInTheDocument();
  });
  it("초기 오류는 요청 ID와 재시도를 제공하고 정상 위젯은 유지한다", async () => {
    let failed = true;
    const fixture = setup({
      "GET /admin/cost/anomalies": () => {
        if (failed) throw apiFailure("private", 500, "req_budget");
        return anomalies;
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("req_budget");
    expect(await screen.findByText("팀 · 예산 소유 팀")).toBeInTheDocument();
    expect(screen.queryByText("예산이 없습니다.")).not.toBeInTheDocument();
    expect(screen.queryByText("반복 호출이 없습니다.")).not.toBeInTheDocument();
    failed = false;
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("예산이 없습니다.")).toBeInTheDocument();
    expect(fixture.api.calls.filter((call) => call.key === "GET /admin/cost/anomalies")).toHaveLength(2);
  });
  it("경고 최초 실패 수치는 0으로 보이지 않는다", async () => {
    setup({
      "GET /admin/budgets/alerts": () => {
        throw apiFailure("private", 500);
      },
    });
    await screen.findByRole("alert");
    expect(screen.getByText("경고·위험 예산").closest("article")).toHaveTextContent("—");
    expect(screen.queryByText("예산 경고 항목이 없습니다.")).not.toBeInTheDocument();
  });
  it("갱신 실패 시 마지막 정상 경고와 갱신 실패 안내를 함께 유지한다", async () => {
    let failed = false;
    const fixture = setup({
      "GET /admin/budgets/alerts": () => {
        if (failed) throw apiFailure("private", 500);
        return alerts;
      },
    });
    await screen.findByText("팀 · 예산 소유 팀");
    failed = true;
    await act(async () => {
      await fixture.client.invalidateQueries({ queryKey: ["finops"] });
    });
    expect(await screen.findByText(/마지막으로 확인한 값을 표시합니다/u)).toBeInTheDocument();
    expect(screen.getByText("팀 · 예산 소유 팀")).toBeInTheDocument();
    expect(screen.getByText("위험")).toBeInTheDocument();
  });
  it.each([401, 403])("%i 응답은 모든 예산 데이터를 숨기고 명시적 재시도만 허용한다", async (status) => {
    let denied = false;
    const fixture = setup({
      "GET /admin/cost/anomalies": () => {
        if (denied) throw apiFailure("private", status);
        return anomalies;
      },
    });
    await screen.findByText("팀 · 예산 소유 팀");
    denied = true;
    await act(async () => {
      await fixture.client.invalidateQueries({ queryKey: ["finops"] });
    });
    expect(await screen.findByText("예산 조회 권한을 다시 확인하세요.")).toBeInTheDocument();
    expect(screen.queryByText("팀 · 예산 소유 팀")).not.toBeInTheDocument();
    expect(fixture.client.getQueryCache().getAll()).toHaveLength(0);
    denied = false;
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("팀 · 예산 소유 팀")).toBeInTheDocument();
  });
  it.each(["identity", "read", "feature", "unmount"])(
    "%s 변경 후 늦은 응답은 화면과 캐시에 남지 않는다",
    async (change) => {
      const pending = deferred();
      let calls = 0;
      const fixture = setup({
        "GET /admin/budgets/alerts": () => (++calls === 1 ? pending.promise : { alerts: [], warn: 0 }),
      });
      await waitFor(() => expect(calls).toBe(1));
      if (change === "identity") runtime.id = "operator_b";
      if (change === "read") runtime.read = false;
      if (change === "feature") runtime.permitted = false;
      if (change === "unmount") runtime.mounted = false;
      fixture.refresh();
      await act(async () => pending.resolve(alerts));
      expect(screen.queryByText("팀 · 예산 소유 팀")).not.toBeInTheDocument();
      expect(
        JSON.stringify(
          fixture.client
            .getQueryCache()
            .getAll()
            .map((query) => query.state.data),
        ),
      ).not.toContain("예산 소유 팀");
    },
  );
  it("비용 조회 권한만으로 관리자 예산 API를 호출하지 않는다", () => {
    runtime.read = false;
    const fixture = setup();
    expect(screen.getByRole("alert")).toHaveTextContent("admin:read");
    expect(fixture.api.calls).toHaveLength(0);
  });
  it("조회와 새로고침은 알림을 발송하지 않는다", async () => {
    const fixture = setup();
    await screen.findByText("팀 · 예산 소유 팀");
    await act(async () => {
      await fixture.client.invalidateQueries({ queryKey: ["finops"] });
    });
    for (const call of fixture.api.calls.filter((call) => call.key === "GET /admin/budgets/alerts"))
      expect(call.options.query).toEqual({ all: 1 });
  });
});
describe("예산 관리 연결", () => {
  it.each(["preview", "preview_read_only", "stable"])("%s 대상의 할당량 탭으로 연결한다", (status) => {
    runtime.destination = status;
    renderScreen(<BudgetManagementLink />);
    expect(screen.getByRole("link", { name: "할당량·예산 관리 열기" })).toHaveAttribute(
      "href",
      "/access/users?tab=quotas",
    );
  });
  it("기존 화면 대상은 레지스트리 경로로 연결한다", () => {
    runtime.destination = "legacy";
    renderScreen(<BudgetManagementLink />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/admin#/users");
  });
  it.each(["hidden", "denied", "no-fallback", "read"])(
    "%s 대상은 접근 링크를 제공하지 않는다",
    (condition) => {
      if (condition === "hidden") runtime.destination = "hidden";
      if (condition === "denied") runtime.destinationAllowed = false;
      if (condition === "no-fallback") {
        runtime.destination = "legacy";
        runtime.fallback = false;
      }
      if (condition === "read") runtime.read = false;
      renderScreen(<BudgetManagementLink />);
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    },
  );
});
