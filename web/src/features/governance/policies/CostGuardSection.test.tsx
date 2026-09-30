import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CostGuardSection } from "./CostGuardSection";
import { confirmedCostGuard, costGuardFormSchema } from "./cost-guard-state";
import { costGuardQueryKeys } from "@/shared/api/domains/cost-guard";
import { publishLogout, tokenStore } from "@/shared/auth/token-store";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const initial = { enabled: true, threshold_krw: 500 };
const key = costGuardQueryKeys.governance;
const title = "비용 보호 설정 수정";
const saveLabel = "비용 보호 설정 저장";
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(load: ApiHandler = () => initial, save: ApiHandler = () => initial, writable = true) {
  const api = mockApi({ "GET /admin/cost": load, "POST /admin/cost": save });
  let changeWrite: (value: boolean) => void = () => undefined;
  function Harness() {
    const [canWrite, setCanWrite] = useState(writable);
    changeWrite = setCanWrite;
    return (
      <main id="main-content" tabIndex={-1}>
        <CostGuardSection canWrite={canWrite} />
      </main>
    );
  }
  return { api, ...renderScreen(<Harness />), setWrite: (value: boolean) => changeWrite(value) };
}
async function open(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole("button", { name: title });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  return await screen.findByRole("dialog", { name: title });
}
const input = (dialog: HTMLElement) => within(dialog).getByRole("spinbutton", { name: "요청당 임계값 (원)" });
const save = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: saveLabel });
function form(dialog: HTMLElement) {
  const node = dialog.querySelector("form");
  if (!node) throw new Error("missing cost form");
  return node;
}
beforeEach(() => {
  tokenStore.clearAll();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("비용 보호 조회와 숫자 계약", () => {
  it("확인된 false/0와 미확인·오류·일시중지·무효화를 구별한다", () => {
    const state = {
      status: "success",
      fetchStatus: "idle",
      data: { enabled: false, threshold_krw: 0 },
    } as const;
    expect(confirmedCostGuard(state)).toEqual(state.data);
    expect(confirmedCostGuard(undefined)).toBeUndefined();
    for (const override of [
      { status: "pending" },
      { status: "error" },
      { fetchStatus: "fetching" },
      { fetchStatus: "paused" },
      { isInvalidated: true },
      { data: undefined },
      { data: null },
      { data: {} },
    ])
      expect(
        confirmedCostGuard({ ...state, ...override } as Parameters<typeof confirmedCostGuard>[0]),
      ).toBeUndefined();
  });
  it("빈 값·음수·무한대는 거부하고 명시 0과 소수는 허용한다", () => {
    for (const thresholdKrw of ["", " ", "-1", "Infinity", "NaN", "1e999"])
      expect(costGuardFormSchema.safeParse({ enabled: false, thresholdKrw }).success).toBe(false);
    for (const thresholdKrw of ["0", "0.125", "12.50"])
      expect(costGuardFormSchema.parse({ enabled: false, thresholdKrw })).toEqual({
        enabled: false,
        thresholdKrw: Number(thresholdKrw),
      });
  });
  it("조회 중에는 중지나 0원을 만들어 내지 않고 수정하지 않는다", async () => {
    const load = deferred();
    const { api } = setup(() => load.promise);
    expect(await screen.findByText("설정 미확인")).toBeVisible();
    expect(screen.getByRole("button", { name: title })).toBeDisabled();
    expect(screen.queryByText("사용 안 함")).not.toBeInTheDocument();
    expect(screen.queryByText("비용 검사 제한 없음")).not.toBeInTheDocument();
    await act(async () => load.resolve({ enabled: false, threshold_krw: 0 }));
    expect(await screen.findByText("비용 검사 제한 없음")).toBeVisible();
    expect(api.bodies("POST /admin/cost")).toEqual([]);
  });
  it("조회 오류는 요청 ID와 수동 재시도로 복구한다", async () => {
    let failure = true;
    const user = userEvent.setup();
    setup(() => {
      if (failure) throw apiFailure("unavailable", 503, "req_cost_read");
      return initial;
    });
    expect(await screen.findByText(/요청 ID: req_cost_read/u)).toBeVisible();
    expect(screen.getByRole("button", { name: title })).toBeDisabled();
    failure = false;
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    await open(user);
  });
  it("정상 조회도 무효화만 되면 미확인 상태와 저장 차단으로 바뀐다", async () => {
    const user = userEvent.setup();
    const { client, api } = setup();
    const dialog = await open(user);
    await user.clear(input(dialog));
    await user.type(input(dialog), "600");
    await act(async () => client.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" }));
    expect(save(dialog)).toBeDisabled();
    expect(input(dialog)).toHaveValue(600);
    fireEvent.submit(form(dialog));
    expect(api.bodies("POST /admin/cost")).toEqual([]);
  });
  it.each([{}, null, { enabled: true }, { enabled: false, threshold_krw: null }])(
    "불완전한 응답을 편집 기준으로 사용하지 않는다: %j",
    async (response) => {
      setup(() => response);
      await waitFor(() => expect(screen.getByText(/설정 조회가 필요합니다/u)).toBeVisible());
      expect(screen.getByRole("button", { name: title })).toBeDisabled();
      expect(screen.queryByText("사용 안 함")).not.toBeInTheDocument();
    },
  );
  it("작은 소수 임계값을 0원으로 반올림하지 않는다", async () => {
    setup(() => ({ enabled: true, threshold_krw: 0.000125 }));
    expect(await screen.findByText("0.000125원")).toBeVisible();
  });
});

describe("비용 보호 미저장 초안", () => {
  it("열린 초안은 자동 재조회에 덮이지 않고 취소·폐기 후 포커스를 복원한다", async () => {
    const user = userEvent.setup();
    let loaded = initial;
    const { client, api } = setup(() => loaded);
    const dialog = await open(user);
    await user.clear(input(dialog));
    await user.type(input(dialog), "123.45");
    loaded = { enabled: false, threshold_krw: 999 };
    await act(async () => client.invalidateQueries({ queryKey: key }));
    expect(input(dialog)).toHaveValue(123.45);
    expect(within(dialog).getByRole("switch")).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    const guard = await screen.findByRole("alertdialog");
    await user.click(within(guard).getByRole("button", { name: "계속 편집" }));
    expect(input(dialog)).toHaveValue(123.45);
    await user.keyboard("{Escape}");
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: title })).toHaveFocus();
    const next = await open(user);
    expect(input(next)).toHaveValue(999);
    expect(api.bodies("POST /admin/cost")).toEqual([]);
  });
  it("빈 숫자는 0이 아니며 첫 오류 필드에 포커스를 둔다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const dialog = await open(user);
    await user.clear(input(dialog));
    await user.click(save(dialog));
    expect(
      await within(dialog).findByText("요청당 임계값을 입력하세요. 빈 값은 0이 아닙니다."),
    ).toBeVisible();
    await waitFor(() => expect(input(dialog)).toHaveFocus());
    expect(input(dialog)).toHaveAttribute("step", "any");
    expect(api.bodies("POST /admin/cost")).toEqual([]);
  });
  it("수동 조회 실패·재시도와 beforeunload는 초안 값을 유지한다", async () => {
    const user = userEvent.setup();
    let failed = false;
    const { api } = setup(() => {
      if (failed) throw apiFailure("unavailable", 503, "req_draft_read");
      return initial;
    });
    const dialog = await open(user);
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await user.clear(input(dialog));
    await user.type(input(dialog), "123.75");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    failed = true;
    await user.click(within(dialog).getByRole("button", { name: "현재 설정 다시 조회" }));
    expect(await within(dialog).findByText(/req_draft_read/u)).toBeVisible();
    expect(input(dialog)).toHaveValue(123.75);
    expect(save(dialog)).toBeDisabled();
    failed = false;
    await user.click(within(dialog).getByRole("button", { name: "현재 설정 다시 조회" }));
    await waitFor(() => expect(save(dialog)).toBeEnabled());
    expect(input(dialog)).toHaveValue(123.75);
    expect(api.bodies("POST /admin/cost")).toEqual([]);
  });
  it("명시적 사용 중지·0과 소수를 그대로 저장하고 두 정확한 캐시만 갱신한다", async () => {
    const user = userEvent.setup();
    const { client, api } = setup();
    client.setQueryDefaults([...key, "unrelated"], { gcTime: Infinity });
    client.setQueryDefaults(costGuardQueryKeys.routing, { gcTime: Infinity });
    client.setQueryData([...key, "unrelated"], initial);
    client.setQueryData(costGuardQueryKeys.routing, initial);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const dialog = await open(user);
    await user.click(within(dialog).getByRole("switch"));
    await user.clear(input(dialog));
    await user.type(input(dialog), "0");
    expect(within(dialog).getByText(/이 예상 비용 검사가 요청을 차단하지 않습니다/u)).toBeVisible();
    expect(within(dialog).getByText(/X-Cost-Approve: 1/u)).toBeVisible();
    await user.click(save(dialog));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(api.bodies("POST /admin/cost")).toEqual([{ enabled: false, threshold_krw: 0 }]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key, exact: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: costGuardQueryKeys.routing, exact: true });
    expect(client.getQueryState([...key, "unrelated"])?.isInvalidated).toBe(false);
    const second = await open(user);
    await user.clear(input(second));
    await user.type(input(second), "0.125");
    await user.click(save(second));
    await waitFor(() => expect(second).not.toBeInTheDocument());
    expect(api.bodies("POST /admin/cost")[1]).toEqual({ enabled: true, threshold_krw: 0.125 });
  });
  it("실패는 입력·요청 ID를 보존하고 수정한 명시적 재시도만 전송한다", async () => {
    const user = userEvent.setup();
    let failure = true;
    const { api } = setup(undefined, () => {
      if (failure) throw apiFailure("failed", 500, "req_cost_save");
      return initial;
    });
    const dialog = await open(user);
    await user.clear(input(dialog));
    await user.type(input(dialog), "600.25");
    await user.click(save(dialog));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("req_cost_save");
    expect(input(dialog)).toHaveValue(600.25);
    await user.clear(input(dialog));
    await user.type(input(dialog), "601.25");
    failure = false;
    await user.click(save(dialog));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(api.bodies("POST /admin/cost")).toEqual([
      { enabled: true, threshold_krw: 600.25 },
      { enabled: true, threshold_krw: 601.25 },
    ]);
  });
  it("동시 제출은 한 번이고 진행 중 입력·재조회·닫기를 잠근다", async () => {
    const flight = deferred();
    const user = userEvent.setup();
    const { api } = setup(undefined, () => flight.promise);
    const dialog = await open(user);
    await user.clear(input(dialog));
    await user.type(input(dialog), "700.5");
    act(() => {
      fireEvent.submit(form(dialog));
      fireEvent.submit(form(dialog));
    });
    await waitFor(() => expect(api.bodies("POST /admin/cost")).toHaveLength(1));
    expect(Object.isFrozen(api.bodies("POST /admin/cost")[0])).toBe(true);
    expect(input(dialog)).toBeDisabled();
    expect(within(dialog).getByRole("switch")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "현재 설정 다시 조회" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    await act(async () => flight.resolve(initial));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(api.bodies("POST /admin/cost")).toHaveLength(1);
  });
  it("읽기 전용과 열린 뒤 쓰기 권한 회수는 직접 submit도 차단한다", async () => {
    const user = userEvent.setup();
    const { setWrite, api } = setup(undefined, undefined, false);
    await waitFor(() => expect(screen.getByText("사용 중")).toBeVisible());
    expect(screen.getByRole("button", { name: title })).toBeDisabled();
    act(() => setWrite(true));
    const dialog = await open(user);
    act(() => setWrite(false));
    expect(input(dialog)).toBeDisabled();
    expect(save(dialog)).toBeDisabled();
    fireEvent.submit(form(dialog));
    expect(api.bodies("POST /admin/cost")).toEqual([]);
  });
  it("검증과 같은 tick의 무효화는 실제 POST 직전에 다시 차단한다", async () => {
    const user = userEvent.setup();
    const { api, client } = setup();
    const dialog = await open(user);
    act(() => {
      fireEvent.submit(form(dialog));
      void client.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" });
    });
    await waitFor(() => expect(save(dialog)).toBeDisabled());
    expect(api.bodies("POST /admin/cost")).toEqual([]);
  });
  it("저장 성공 뒤 GET 실패는 저장 실패나 자동 재전송이 아니다", async () => {
    const user = userEvent.setup();
    let failed = false;
    const { api } = setup(
      () => {
        if (failed) throw apiFailure("read unavailable", 503, "req_after_commit");
        return initial;
      },
      () => {
        failed = true;
        return initial;
      },
    );
    const dialog = await open(user);
    await user.clear(input(dialog));
    await user.type(input(dialog), "800");
    await user.click(save(dialog));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(await screen.findByText("설정 저장은 완료됐습니다.")).toBeVisible();
    expect(screen.getByText(/요청 ID: req_after_commit/u)).toBeVisible();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    failed = false;
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.queryByText("설정 저장은 완료됐습니다.")).not.toBeInTheDocument());
    expect(api.bodies("POST /admin/cost")).toHaveLength(1);
  });
  it("이전 저장의 조회가 복구되면 나중 저장·조회 실패에 과거 성공 안내를 재사용하지 않는다", async () => {
    const user = userEvent.setup();
    let readFails = false;
    let saveFails = false;
    const { api } = setup(
      () => {
        if (readFails) throw apiFailure("read failed", 503, "req_later_read");
        return initial;
      },
      () => {
        if (saveFails) throw apiFailure("save failed", 500, "req_later_save");
        return initial;
      },
    );
    const first = await open(user);
    await user.click(save(first));
    await waitFor(() => expect(first).not.toBeInTheDocument());
    const second = await open(user);
    await user.clear(input(second));
    await user.type(input(second), "901");
    saveFails = true;
    await user.click(save(second));
    expect(await within(second).findByRole("alert")).toHaveTextContent("req_later_save");
    readFails = true;
    await user.click(within(second).getByRole("button", { name: "현재 설정 다시 조회" }));
    expect(await within(second).findByText(/req_later_read/u)).toBeVisible();
    expect(screen.queryByText("설정 저장은 완료됐습니다.")).not.toBeInTheDocument();
    expect(input(second)).toHaveValue(901);
    expect(api.bodies("POST /admin/cost")).toHaveLength(2);
  });

  for (const outcome of ["success", "failure"] as const)
    it(`이전 세션의 늦은 ${outcome} 응답은 새 초안과 알림을 건드리지 않는다`, async () => {
      const flight = deferred();
      const user = userEvent.setup();
      let attempts = 0;
      const { api, client } = setup(undefined, () => (++attempts === 1 ? flight.promise : initial));
      const first = await open(user);
      await user.clear(input(first));
      await user.type(input(first), "111");
      await user.click(save(first));
      await waitFor(() => expect(api.bodies("POST /admin/cost")).toHaveLength(1));
      act(() => {
        publishLogout();
        client.clear();
        tokenStore.saveTokens({ access_token: "public-test-second", refresh_token: "public-test-refresh" });
      });
      const second = await open(user);
      await user.clear(input(second));
      await user.type(input(second), "222");
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await act(async () => {
        if (outcome === "success") flight.resolve(initial);
        else flight.reject(apiFailure("late", 500, "req_old"));
      });
      expect(second).toBeVisible();
      expect(input(second)).toHaveValue(222);
      expect(save(second)).toBeEnabled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      await user.click(save(second));
      await waitFor(() => expect(second).not.toBeInTheDocument());
      expect(api.bodies("POST /admin/cost")[1]).toEqual({ enabled: true, threshold_krw: 222 });
    });
});
