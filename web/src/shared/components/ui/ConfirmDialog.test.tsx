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
