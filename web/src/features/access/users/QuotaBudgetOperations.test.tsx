import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { QuotasTab } from "./QuotasTab";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({
  id: "operator_a",
  role: "admin",
  read: true,
  write: true,
  readOnly: false,
  mounted: true,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        role: runtime.role,
        user: { id: runtime.id },
        scopes: [...(runtime.read ? ["admin:read"] : []), ...(runtime.write ? ["admin:write"] : [])],
      }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => {
  Object.assign(runtime, {
    id: "operator_a",
    role: "admin",
    read: true,
    write: true,
    readOnly: false,
    mounted: true,
  });
  vi.clearAllMocks();
});
const quota = {
  id: "quota_fixture",
  scope: "team",
  scope_value: "할당량 팀",
  period: "monthly",
  enabled: true,
  token_limit: 100,
  krw_limit: 500,
  note: "기존 메모",
};
const quotas = {
  quotas: [quota],
  usage: [
    {
      quota,
      tokens: 5,
      cost_krw: 10,
      token_remain_ratio: 0.95,
      krw_remain_ratio: 0.98,
      period_start: "2026-10-01T00:00:00Z",
      period_end: "2026-11-01T00:00:00Z",
    },
  ],
};
const budget = {
  id: "budget_fixture",
  scope: "team",
  scope_value: "예산 팀",
  monthly_krw: 1000,
  note: "예산 메모",
};
const budgets = {
  budgets: [
    { budget, spent_krw: 20, burn_ratio: 0.02, projected_krw: 60, projected_ratio: 0.06, on_track: true },
  ],
};
const projection = { teams: [], exceeding: 0 };
const alerts = { alerts: [], warn: 0, critical: 0 };
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(handlers: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/quotas": () => quotas,
    "GET /admin/budgets": () => budgets,
    "GET /admin/budgets/projection": () => projection,
    "GET /admin/budgets/alerts": () => alerts,
    "POST /admin/quotas": () => ({ quota }),
    "PATCH /admin/quotas/quota_fixture": () => ({ quota }),
    "DELETE /admin/quotas/quota_fixture": () => ({ deleted: true }),
    "POST /admin/budgets": () => ({ budget }),
    "DELETE /admin/budgets/budget_fixture": () => ({ deleted: true }),
    ...handlers,
  });
  let update = () => {};
  function Host() {
    const [, force] = useReducer((n) => n + 1, 0);
    update = force;
    return (
      <FeatureAccessContext.Provider
        value={{ featureId: "access.users", permitted: true, readOnly: runtime.readOnly }}
      >
        {runtime.mounted ? <QuotasTab canWrite writeDeniedReason="관리자 변경 권한이 필요합니다." /> : null}
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Host />);
  return {
    api,
    view,
    update: () => act(() => update()),
    writes: () => api.calls.filter((call) => !call.key.startsWith("GET ")),
  };
}
const operations = [
  {
    name: "할당량 추가",
    key: "POST /admin/quotas",
    button: "저장",
    body: { scope: "team", scope_value: "신규 팀", period: "monthly", token_limit: 250, enabled: true },
  },
  {
    name: "예산 추가",
    key: "POST /admin/budgets",
    button: "저장",
    body: { scope: "team", scope_value: "신규 팀", monthly_krw: 250 },
  },
  {
    name: "할당량 수정",
    key: "PATCH /admin/quotas/quota_fixture",
    button: "저장",
    body: { token_limit: 100, krw_limit: 500, enabled: true, note: "기존 메모" },
  },
  { name: "할당량 중지", key: "PATCH /admin/quotas/quota_fixture", button: "중지", body: { enabled: false } },
  { name: "할당량 삭제", key: "DELETE /admin/quotas/quota_fixture", button: "삭제", body: undefined },
  { name: "예산 삭제", key: "DELETE /admin/budgets/budget_fixture", button: "삭제", body: undefined },
] as const;
async function open(user: ReturnType<typeof userEvent.setup>, operation: (typeof operations)[number]) {
  await screen.findByText("할당량 팀");
  if (operation.name.endsWith("추가")) {
    await user.click(screen.getByRole("button", { name: operation.name }));
    const dialog = within(screen.getByRole("dialog", { name: operation.name }));
    await user.type(dialog.getByRole("textbox", { name: "대상" }), "신규 팀");
    await user.type(
      dialog.getByRole("spinbutton", { name: operation.name === "예산 추가" ? /월 예산/ : "토큰 한도" }),
      "250",
    );
  } else {
    const table = within(
      screen.getByRole("table", {
        name: operation.name.startsWith("예산") ? "월 예산 소진 현황" : "할당량과 사용량",
      }),
    );
    await user.click(table.getByRole("button", { name: operation.name.replace(/^(할당량|예산) /, "") }));
  }
  return within(screen.getByRole("dialog", { name: operation.name }));
}
describe("할당량·예산 작업 수명", () => {
  it("사용 여부만 바꿔도 변경 비교와 저장하지 않은 변경 경고를 표시한다", async () => {
    const user = userEvent.setup();
    const { writes } = setup();
    const dialog = await open(user, operations[2]);
    await user.click(dialog.getByRole("switch", { name: "사용 중" }));
    const comparison = within(dialog.getByRole("table", { name: "저장 전 변경 비교" }));
    expect(comparison.getByRole("row", { name: "상태 사용 중지" })).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "취소" }));
    expect(screen.getByRole("alertdialog", { name: /저장하지 않은 변경/ })).toBeVisible();
    expect(writes()).toHaveLength(0);
  });
  it.each(operations)("$name은 기존 본문을 한 번만 전송하고 자동 401 재시도를 끈다", async (operation) => {
    const user = userEvent.setup();
    const held = deferred();
    const { api, writes } = setup({ [operation.key]: () => held.promise });
    const dialog = await open(user, operation);
    await user.dblClick(dialog.getByRole("button", { name: operation.button }));
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.options.body).toEqual(operation.body);
    expect(
      api.spy.mock.calls.find(([endpoint]) => `${endpoint.method} ${endpoint.path}` === operation.key)?.[1],
    ).toMatchObject({ retryUnauthorized: false });
    await act(async () => held.resolve({ quota, budget, deleted: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
  it.each(operations)("$name 확인 후 쓰기 권한이 회수되면 실행을 막고 입력을 보존한다", async (operation) => {
    const user = userEvent.setup();
    const { update, writes } = setup();
    const dialog = await open(user, operation);
    runtime.write = false;
    update();
    expect(dialog.getByRole("button", { name: operation.button })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "취소" })).toBeEnabled();
    expect(dialog.getByText("관리자 변경 권한이 필요합니다.")).toBeVisible();
    if (operation.name.endsWith("추가"))
      expect(dialog.getByRole("textbox", { name: "대상" })).toHaveValue("신규 팀");
    expect(writes()).toHaveLength(0);
  });
  it.each(operations)("$name은 기능 읽기 전용 전환 후 실행하지 않는다", async (operation) => {
    const user = userEvent.setup();
    const { update, writes } = setup();
    const dialog = await open(user, operation);
    runtime.readOnly = true;
    update();
    expect(dialog.getByRole("button", { name: operation.button })).toBeDisabled();
    expect(writes()).toHaveLength(0);
  });
  it.each(operations)("$name의 늦은 성공은 다른 계정 화면을 갱신하거나 닫지 않는다", async (operation) => {
    const user = userEvent.setup();
    const held = deferred();
    const { update, api } = setup({ [operation.key]: () => held.promise });
    const dialog = await open(user, operation);
    await user.click(dialog.getByRole("button", { name: operation.button }));
    runtime.id = "operator_b";
    update();
    await screen.findByText("할당량 팀");
    await open(user, operations[1]);
    const before = api.calls.length;
    await act(async () => held.resolve({ quota, budget, deleted: true }));
    expect(screen.getByRole("dialog", { name: "예산 추가" })).toBeVisible();
    expect(api.calls).toHaveLength(before);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
  it.each(operations)("$name의 늦은 오류는 변경 권한 회수 후 알림을 만들지 않는다", async (operation) => {
    const user = userEvent.setup();
    const held = deferred();
    const { update } = setup({ [operation.key]: () => held.promise });
    const dialog = await open(user, operation);
    await user.click(dialog.getByRole("button", { name: operation.button }));
    runtime.write = false;
    update();
    await act(async () => held.reject(apiFailure("private-quota-value")));
    expect(screen.getByRole("dialog", { name: operation.name })).toBeVisible();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByText(/private-quota-value/)).not.toBeInTheDocument();
  });
  it("팀 관리자 예외는 할당량·예산 변경 권한을 부여하지 않는다", async () => {
    runtime.role = "team_admin";
    runtime.write = false;
    setup();
    expect(await screen.findByRole("button", { name: "할당량 추가" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "예산 추가" })).toBeDisabled();
  });
  it("화면 재마운트 후에도 기존 변경 완료 전 다른 예산 작업을 보내지 않는다", async () => {
    const user = userEvent.setup();
    const held = deferred();
    const { update, writes } = setup({ "POST /admin/quotas": () => held.promise });
    const first = await open(user, operations[0]);
    await user.click(first.getByRole("button", { name: "저장" }));
    runtime.mounted = false;
    update();
    runtime.mounted = true;
    update();
    const second = await open(user, operations[1]);
    await user.click(second.getByRole("button", { name: "저장" }));
    expect(writes()).toHaveLength(1);
    await act(async () => held.resolve({ quota }));
    expect(toast.success).not.toHaveBeenCalled();
    await user.click(second.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
  });
  it.each(["/admin/quotas", "/admin/budgets", "/admin/budgets/projection", "/admin/budgets/alerts"])(
    "%s 권한 오류는 이전 데이터와 편집창을 폐기한다",
    async (path) => {
      let denied = false;
      const user = userEvent.setup();
      const values: Record<string, unknown> = {
        "/admin/quotas": quotas,
        "/admin/budgets": budgets,
        "/admin/budgets/projection": projection,
        "/admin/budgets/alerts": alerts,
      };
      const { view } = setup({
        [`GET ${path}`]: () => {
          if (denied) throw apiFailure("private-read", 403);
          return values[path];
        },
      });
      await screen.findByText("할당량 팀");
      if (path.endsWith("alerts")) await user.click(screen.getByRole("button", { name: "경보 확인" }));
      await open(user, operations[0]);
      denied = true;
      await act(async () => {
        await view.client.invalidateQueries({ queryKey: ["access"] });
      });
      expect(await screen.findByText("할당량·예산 조회 권한을 다시 확인하세요.")).toBeVisible();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByText("할당량 팀")).not.toBeInTheDocument();
    },
  );
  it.each(["할당량", "예산", "지출 예측"])(
    "%s 첫 조회 오류를 정상 빈 목록으로 표시하지 않는다",
    async (label) => {
      const paths: Record<string, string> = {
        할당량: "/admin/quotas",
        예산: "/admin/budgets",
        "지출 예측": "/admin/budgets/projection",
      };
      setup({
        [`GET ${paths[label]}`]: () => {
          throw apiFailure("private-data");
        },
      });
      expect(await screen.findByText(`${label}을(를) 불러오지 못했습니다.`)).toBeVisible();
      const empty: Record<string, string> = {
        할당량: "설정된 할당량이 없습니다.",
        예산: "설정된 예산이 없습니다.",
        "지출 예측": "예측할 팀 사용량이 없습니다.",
      };
      expect(screen.queryByText(empty[label] ?? "")).not.toBeInTheDocument();
    },
  );
  it("경보 확인은 반복 조회할 수 있고 조회 요청에는 발송 옵션이 없다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByText("할당량 팀");
    await user.click(screen.getByRole("button", { name: "경보 확인" }));
    await screen.findByText("경보가 없습니다.");
    await user.click(screen.getByRole("button", { name: "경보 확인" }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.key === "GET /admin/budgets/alerts")).toHaveLength(2),
    );
    expect(
      api.calls
        .filter((c) => c.key === "GET /admin/budgets/alerts")
        .every((c) => JSON.stringify(c.options.query) === '{"all":1}'),
    ).toBe(true);
  });
  it("음수 비용과 소수 토큰은 생성 전에 필드 오류로 거부한다", async () => {
    const user = userEvent.setup();
    const { writes } = setup();
    const dialog = await open(user, operations[0]);
    await user.clear(dialog.getByRole("spinbutton", { name: "토큰 한도" }));
    await user.type(dialog.getByRole("spinbutton", { name: "토큰 한도" }), "1.5");
    await user.type(dialog.getByRole("spinbutton", { name: "비용 한도(원)" }), "-10");
    await user.click(dialog.getByRole("button", { name: "저장" }));
    expect(await dialog.findByText("0 이상의 안전한 정수 토큰 수를 입력하세요.")).toBeVisible();
    expect(dialog.getByText("0 이상의 유한한 금액을 입력하세요.")).toBeVisible();
    expect(writes()).toHaveLength(0);
  });
});
