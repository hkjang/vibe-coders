import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { BudgetNotificationAction } from "./BudgetNotificationAction";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
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
const result = { alerts: [], warn: 0, critical: 0, thresholds: { warn: 0.8, critical: 1 } };
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(handler: () => unknown = () => result) {
  const api = mockApi({ "GET /admin/budgets/alerts": handler });
  let update = () => {};
  function Host() {
    const [, force] = useReducer((n) => n + 1, 0);
    update = force;
    return (
      <FeatureAccessContext.Provider
        value={{ featureId: "access.users", permitted: true, readOnly: runtime.readOnly }}
      >
        {runtime.mounted ? (
          <BudgetNotificationAction
            canWrite
            writeDeniedReason="예산 경보 발송에는 관리자 변경 권한이 필요합니다."
          />
        ) : null}
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Host />);
  return { api, view, update: () => act(() => update()) };
}
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "경보 발송" }));
  return within(screen.getByRole("dialog", { name: "예산 경보 발송" }));
}
describe("예산 경보 발송 보호", () => {
  it.each(["success", "error"])(
    "발송 중 변경 권한을 잃으면 늦은 %s 결과가 확인창을 닫거나 알림을 만들지 않는다",
    async (outcome) => {
      const user = userEvent.setup();
      const held = deferred();
      const { update } = setup(() => held.promise);
      const dialog = await open(user);
      await user.click(dialog.getByRole("button", { name: "발송" }));
      runtime.write = false;
      update();
      await act(async () => {
        if (outcome === "success") held.resolve(result);
        else held.reject(apiFailure("private-server-value"));
      });
      expect(screen.getByRole("dialog", { name: "예산 경보 발송" })).toBeVisible();
      expect(dialog.getByRole("button", { name: "발송" })).toBeDisabled();
      expect(dialog.getByRole("button", { name: "취소" })).toBeEnabled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    },
  );
  it("조회·확인창 열기·취소로는 발송하지 않고 취소 후 초점을 돌려준다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const dialog = await open(user);
    expect(dialog.getByText(/발송 대상이 없거나 알림 연동이 꺼져/)).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "취소" }));
    expect(api.calls).toHaveLength(0);
    expect(screen.getByRole("button", { name: "경보 발송" })).toHaveFocus();
  });
  it("명시적 확인만 한 번 실행하고 자동 인증 재시도와 허위 발송 건수를 사용하지 않는다", async () => {
    const user = userEvent.setup();
    const held = deferred();
    const { api } = setup(() => held.promise);
    const dialog = await open(user);
    await user.dblClick(dialog.getByRole("button", { name: "발송" }));
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.options.query).toEqual({ all: 1, notify: 1 });
    expect(api.spy.mock.calls[0]?.[1]).toMatchObject({ retryUnauthorized: false });
    expect(dialog.getByRole("button", { name: "처리 중" })).toBeDisabled();
    await act(async () => held.resolve(result));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith(
      "예산 경보 발송 요청을 처리했습니다. 실제 수신 여부는 알림 채널에서 확인하세요.",
    );
  });
  it.each(["admin", "team_admin"])("%s도 관리자 변경 범위가 없으면 발송할 수 없다", (role) => {
    runtime.role = role;
    runtime.write = false;
    const { api } = setup();
    expect(screen.getByRole("button", { name: "경보 발송" })).toBeDisabled();
    expect(api.calls).toHaveLength(0);
  });
  it.each(["write", "readOnly"])("확인 중 %s 권한 변경은 확인을 막고 취소를 유지한다", async (change) => {
    const user = userEvent.setup();
    const { api, update } = setup();
    const dialog = await open(user);
    if (change === "write") runtime.write = false;
    else runtime.readOnly = true;
    update();
    expect(dialog.getByRole("button", { name: "발송" })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "취소" })).toBeEnabled();
    expect(api.calls).toHaveLength(0);
  });
  it.each(["identity", "read"])("%s 변경은 이전 확인창을 폐기한다", async (change) => {
    const user = userEvent.setup();
    const { api, update } = setup();
    await open(user);
    if (change === "identity") runtime.id = "operator_b";
    else runtime.read = false;
    update();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });
  it.each(["success", "error"])(
    "다른 계정 화면에는 이전 요청의 %s 결과를 전달하지 않는다",
    async (outcome) => {
      const user = userEvent.setup();
      const held = deferred();
      const { update } = setup(() => held.promise);
      const dialog = await open(user);
      await user.click(dialog.getByRole("button", { name: "발송" }));
      runtime.id = "operator_b";
      update();
      await open(user);
      await act(async () => {
        if (outcome === "success") held.resolve(result);
        else held.reject(apiFailure("private-server-value"));
      });
      expect(screen.getByRole("dialog", { name: "예산 경보 발송" })).toBeVisible();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(screen.queryByText(/private-server-value/)).not.toBeInTheDocument();
    },
  );
  it("화면을 다시 열어도 같은 계정의 미완료 요청을 중복 발송하지 않는다", async () => {
    const user = userEvent.setup();
    const held = deferred();
    const { api, update } = setup(() => held.promise);
    let dialog = await open(user);
    await user.click(dialog.getByRole("button", { name: "발송" }));
    runtime.mounted = false;
    update();
    runtime.mounted = true;
    update();
    dialog = await open(user);
    await user.click(dialog.getByRole("button", { name: "발송" }));
    expect(api.calls).toHaveLength(1);
    await act(async () => held.resolve(result));
    expect(toast.success).not.toHaveBeenCalled();
    await user.click(dialog.getByRole("button", { name: "발송" }));
    await waitFor(() => expect(api.calls).toHaveLength(2));
  });
  it.each([401, 403, 500])(
    "%s 오류는 자동 재발송하지 않고 안전한 오류와 재확인을 제공한다",
    async (status) => {
      const user = userEvent.setup();
      const { api } = setup(() => {
        throw apiFailure("private-server-value", status);
      });
      const dialog = await open(user);
      await user.click(dialog.getByRole("button", { name: "발송" }));
      await waitFor(() => expect(dialog.getByRole("button", { name: "발송" })).toBeEnabled());
      expect(api.calls).toHaveLength(1);
      expect(screen.queryByText(/private-server-value/)).not.toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
    },
  );
});
