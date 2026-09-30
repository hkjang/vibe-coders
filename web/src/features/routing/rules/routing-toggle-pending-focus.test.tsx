import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { useRoutingTogglePendingFocus } from "./routing-toggle-pending-focus";
import { initialRule, openToggle, patchPath, setupToggle } from "./routing-toggle-test-harness";

function holdPatch() {
  let resolve!: (value: { rule: RoutingRule }) => void;
  const promise = new Promise<{ rule: RoutingRule }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("라우팅 확인창의 대기 진입 초점", () => {
  it("실제 확인 버튼이 비활성화되면 같은 바깥 대화상자로 복구하고 첫 Tab을 내부에 유지", async () => {
    const current = await setupToggle();
    const opened = await openToggle(current);
    const held = holdPatch();
    current.response.patch = () => held.promise;
    await current.user.click(within(opened.dialog).getByRole("button", { name: "중지" }));
    await waitFor(() => expect(current.api.bodies(patchPath)).toHaveLength(1));
    expect(within(opened.dialog).getByRole("button", { name: "처리 중" })).toBeDisabled();
    expect(opened.dialog).toHaveFocus();
    await current.user.tab();
    expect(within(opened.dialog).getByRole("button", { name: "대화상자 닫기" })).toHaveFocus();
    await current.user.keyboard("{Escape}");
    expect(opened.dialog).toBeVisible();
    expect(current.api.bodies(patchPath)).toHaveLength(1);
    await act(async () => {
      held.resolve({ rule: { ...initialRule, enabled: false } });
      await held.promise;
    });
    await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
  });

  it("읽기 전용 재렌더는 이미 활성화된 닫기 버튼 초점을 옮기지 않는다", async () => {
    const current = await setupToggle();
    const opened = await openToggle(current);
    const close = within(opened.dialog).getByRole("button", { name: "대화상자 닫기" });
    close.focus();
    current.update("read_only");
    expect(close).toHaveFocus();
    current.update("writable");
    expect(close).toHaveFocus();
    expect(current.api.bodies(patchPath)).toHaveLength(0);
  });

  it("직접 확인 콜백 실행 중에도 비활성화되지 않은 현재 닫기 버튼의 초점은 보존", async () => {
    const current = await setupToggle();
    const opened = await openToggle(current);
    const held = holdPatch();
    current.response.patch = () => held.promise;
    const close = within(opened.dialog).getByRole("button", { name: "대화상자 닫기" });
    close.focus();
    let completion!: Promise<unknown>;
    act(() => {
      completion = Promise.resolve(opened.confirm(""));
    });
    await waitFor(() => expect(current.api.bodies(patchPath)).toHaveLength(1));
    expect(close).toHaveFocus();
    expect(screen.getByRole("dialog")).toBe(opened.dialog);
    await act(async () => {
      held.resolve({ rule: { ...initialRule, enabled: false } });
      await completion;
    });
  });
});

// These controlled DOM tests cover the local hook's fences, not browser focus
// navigation. Real disabled-button -> BODY -> outside Tab evidence is separate.
function setupFocus() {
  const state = { epoch: 1, owner: "routing.rules", pending: false, disabled: false };
  const assertOwned = vi.fn();
  let capture: () => void = () => {
    throw new Error("focus hook has not committed");
  };
  function Harness(props: typeof state) {
    const focus = useRoutingTogglePendingFocus({ ...props, assertOwned }, props.pending);
    useLayoutEffect(() => {
      capture = focus.capture;
    });
    return (
      <>
        <div role="dialog" aria-label="초점 검사" tabIndex={-1}>
          <dl ref={focus.reviewRef}>
            <dt>검토</dt>
            <dd>합성 규칙</dd>
          </dl>
          <button disabled={props.disabled}>확인 원점</button>
          <input aria-label="현재 입력" />
        </div>
        <div role="dialog" aria-label="다른 확인창" tabIndex={-1}>
          <button>다른 작업</button>
        </div>
      </>
    );
  }
  const view = render(<Harness {...state} />);
  const dialog = screen.getByRole("dialog", { name: "초점 검사" });
  const origin = within(dialog).getByRole("button", { name: "확인 원점" });
  const input = within(dialog).getByRole("textbox");
  const other = screen.getByRole("button", { name: "다른 작업" });
  const focus = vi.spyOn(dialog, "focus");
  return {
    dialog,
    origin,
    input,
    other,
    focus,
    assertOwned,
    view,
    capture: () => capture(),
    update(change: Partial<typeof state>) {
      Object.assign(state, change);
      view.rerender(<Harness {...state} />);
    },
  };
}

describe("대기 초점 복구의 로컬 수명 경계", () => {
  it("캡처한 원점 비활성화로 BODY가 활성화된 경우 스크롤 보존 옵션으로 한 번 복구", () => {
    const current = setupFocus();
    current.origin.focus();
    current.capture();
    current.origin.blur();
    expect(document.body).toHaveFocus();
    current.update({ pending: true, disabled: true });
    expect(current.dialog).toHaveFocus();
    expect(current.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    current.input.focus();
    current.update({ pending: true });
    expect(current.input).toHaveFocus();
    expect(current.focus).toHaveBeenCalledOnce();
  });
  for (const target of ["input", "other"] as const) {
    it(`${target}: 전송 준비 뒤 유효한 새 초점으로 옮겼다면 가져오지 않는다`, () => {
      const current = setupFocus();
      current.origin.focus();
      current.capture();
      current[target].focus();
      current.update({ pending: true, disabled: true });
      expect(current[target]).toHaveFocus();
      expect(current.focus).not.toHaveBeenCalled();
    });
  }
  it("다른 대화상자의 버튼에서 호출된 콜백은 복구 원점으로 캡처하지 않는다", () => {
    const current = setupFocus();
    current.other.focus();
    current.capture();
    current.other.blur();
    current.update({ pending: true, disabled: true });
    expect(document.body).toHaveFocus();
    expect(current.focus).not.toHaveBeenCalled();
  });
  for (const change of ["epoch", "owner", "revoked", "hidden", "closed", "enabled"] as const) {
    it(`${change}: 캡처 뒤 변경된 소유권·표시·활성 상태에서는 복구하지 않는다`, () => {
      const current = setupFocus();
      current.origin.focus();
      current.capture();
      current.origin.blur();
      if (change === "revoked")
        current.assertOwned.mockImplementation(() => {
          throw new Error("stale owner");
        });
      if (change === "hidden") current.dialog.setAttribute("aria-hidden", "true");
      if (change === "closed") current.dialog.setAttribute("data-state", "closed");
      current.update({
        pending: true,
        disabled: change !== "enabled",
        ...(change === "epoch" ? { epoch: 2 } : {}),
        ...(change === "owner" ? { owner: "gateway.health" } : {}),
      });
      expect(document.body).toHaveFocus();
      expect(current.focus).not.toHaveBeenCalled();
    });
  }
  it("종료된 화면의 이전 capture 콜백은 소유권 검사나 초점 이동을 실행하지 않는다", () => {
    const current = setupFocus();
    current.origin.focus();
    current.capture();
    const before = current.assertOwned.mock.calls.length;
    current.view.unmount();
    current.capture();
    expect(current.assertOwned).toHaveBeenCalledTimes(before);
    expect(current.focus).not.toHaveBeenCalled();
    expect(document.body).toHaveFocus();
  });
});
