import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, MouseEventHandler } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog";

const callbacks = vi.hoisted(() => ({
  confirm: undefined as MouseEventHandler<HTMLButtonElement> | undefined,
}));
// Capture the component callback itself; removing a DOM disabled attribute would
// not prove React's callback/last-moment guard boundary.
vi.mock("./Button", () => ({
  Button: ({
    children,
    onClick,
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => {
    void _variant;
    void _size;
    if (children === "실행") callbacks.confirm = onClick;
    return (
      <button {...props} onClick={onClick}>
        {children}
      </button>
    );
  },
}));
describe("ConfirmDialog opt-in 전제조건", () => {
  function typedProps(onConfirm = vi.fn<() => Promise<unknown> | unknown>()) {
    return {
      title: "대상 확인",
      description: "공개 합성 대상",
      open: true,
      requireReason: true,
      requireTarget: "공개 대상 정지",
      confirmLabel: "실행",
      onConfirm,
      onOpenChange: vi.fn(),
      returnFocusRef: { current: null },
    };
  }
  async function fillTarget() {
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "공개 변경 사유");
    await user.type(screen.getByRole("textbox", { name: "확인 문구" }), "공개 대상 정지");
    const captured = callbacks.confirm;
    if (!captured) throw new Error("missing typed confirmation callback");
    return captured;
  }
  it("대상이 변경되면 이전 입력과 캡처한 실행 콜백은 재사용할 수 없다", async () => {
    const props = typedProps();
    const view = render(<ConfirmDialog {...props} />);
    const captured = await fillTarget();
    view.rerender(<ConfirmDialog {...props} requireTarget="다른 대상 정지" />);
    act(() => captured({} as Parameters<typeof captured>[0]));
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "확인 문구" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "실행" })).toBeDisabled();
  });
  it("입력을 수정한 뒤 이전 콜백으로 이전 확인 문구를 전송하지 않는다", async () => {
    const props = typedProps();
    render(<ConfirmDialog {...props} />);
    const captured = await fillTarget();
    await userEvent.setup().clear(screen.getByRole("textbox", { name: "확인 문구" }));
    act(() => captured({} as Parameters<typeof captured>[0]));
    expect(props.onConfirm).not.toHaveBeenCalled();
  });
  it("같은 콜백을 동기적으로 두 번 실행해도 한 번만 전송한다", async () => {
    let resolve: (() => void) | undefined;
    const props = typedProps(
      vi.fn(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      ),
    );
    render(<ConfirmDialog {...props} />);
    const captured = await fillTarget();
    act(() => {
      captured({} as Parameters<typeof captured>[0]);
      captured({} as Parameters<typeof captured>[0]);
    });
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).toHaveBeenCalledWith("공개 변경 사유", "공개 대상 정지");
    expect(screen.getByRole("button", { name: "처리 중" })).toBeDisabled();
    await act(async () => resolve?.());
    expect(props.onOpenChange).toHaveBeenCalledTimes(1);
  });
  it("외부에서 닫고 다시 연 확인창을 이전 요청의 늦은 성공으로 닫지 않는다", async () => {
    let resolve: (() => void) | undefined;
    const props = typedProps(
      vi.fn(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      ),
    );
    const view = render(<ConfirmDialog {...props} />);
    const captured = await fillTarget();
    act(() => captured({} as Parameters<typeof captured>[0]));
    view.rerender(<ConfirmDialog {...props} open={false} />);
    view.rerender(<ConfirmDialog {...props} />);
    expect(screen.getByRole("textbox", { name: "확인 문구" })).toHaveValue("");
    await act(async () => resolve?.());
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
  });
  it("readonly flip은 사유를 유지하고 캡처된 confirm까지 막되 취소는 열어 둔다", async () => {
    const onConfirm = vi.fn(),
      onOpenChange = vi.fn();
    const props = {
      title: "작업 확인",
      description: "테스트 확인",
      open: true,
      requireReason: true,
      confirmLabel: "실행",
      onConfirm,
      onOpenChange,
      returnFocusRef: { current: null },
    };
    const view = render(<ConfirmDialog {...props} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "보존할 사유");
    const captured = callbacks.confirm;
    if (!captured) throw new Error("missing confirmation callback");
    view.rerender(<ConfirmDialog {...props} confirmDisabled />);
    expect(screen.getByRole("button", { name: "실행" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "변경 사유" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "변경 사유" })).toHaveValue("보존할 사유");
    act(() => captured({} as Parameters<typeof captured>[0]));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "취소" })).toBeEnabled();
    view.rerender(<ConfirmDialog {...props} confirmDisabled={false} />);
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "실행" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("보존할 사유"));
  });
  it("기본 호출부는 확인 가능하며 disable 중에도 취소·닫기는 가능하다", async () => {
    const onConfirm = vi.fn(),
      onOpenChange = vi.fn();
    const props = {
      title: "작업 확인",
      description: "테스트 확인",
      open: true,
      confirmLabel: "실행",
      onConfirm,
      onOpenChange,
      returnFocusRef: { current: null },
    };
    const view = render(<ConfirmDialog {...props} />);
    expect(screen.getByRole("button", { name: "실행" })).toBeEnabled();
    view.rerender(<ConfirmDialog {...props} confirmDisabled />);
    await userEvent.setup().click(screen.getByRole("button", { name: "취소" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
