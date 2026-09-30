import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";

import { FormDialog } from "./FormDialog";

const hint = "내용이 길면 이 안내에 초점을 둔 뒤 방향키로 살펴보세요.";
function Harness({
  scrollHint,
  save = () => undefined,
}: {
  scrollHint?: string;
  save?: (values: { name: string }) => unknown | Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const form = useForm({ defaultValues: { name: "" } });
  return (
    <>
      <button ref={trigger} onClick={() => setOpen(true)}>
        편집 열기
      </button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={trigger}
        form={form}
        onSubmit={save}
        title="안내 선택 폼"
        description="공개 테스트 입력"
        scrollHint={scrollHint}
      >
        <label>
          이름
          <input {...form.register("name")} />
        </label>
      </FormDialog>
    </>
  );
}

async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "편집 열기" }));
  const dialog = screen.getByRole("dialog", { name: "안내 선택 폼" });
  const form = dialog.querySelector("form");
  if (!form) throw new Error("missing form");
  return { user, dialog, form, input: within(dialog).getByRole("textbox", { name: "이름" }) };
}

describe("FormDialog 선택적 평문 스크롤 안내", () => {
  it("미지정 기본값은 기존 fieldset DOM과 초기 포커스 순서를 유지한다", async () => {
    render(<Harness />);
    const { user, dialog, form, input } = await open();
    expect(Array.from(form.children).map((node) => node.tagName)).toEqual(["FIELDSET"]);
    expect(form.querySelector("[tabindex]")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "대화상자 닫기" })).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
  });

  it("선택한 안내는 입력 뒤 fieldset 밖의 평문이며 기존 첫 입력을 앞서지 않는다", async () => {
    const plain = "<button>실행 없는 평문 안내</button>";
    render(<Harness scrollHint={plain} />);
    const { user, dialog, form, input } = await open();
    const target = within(dialog).getByText(plain);
    expect(Array.from(form.children).map((node) => node.tagName)).toEqual(["FIELDSET", "P"]);
    expect(target.closest("fieldset")).toBeNull();
    expect(target).toHaveAttribute("tabindex", "0");
    expect(target.querySelector("button")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "대화상자 닫기" })).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
    await user.tab();
    expect(target).toHaveFocus();
  });

  it("저장 중 입력·취소·저장은 잠근 채 안내 Tab 접근과 단일 제출을 유지한다", async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = vi.fn(() => pending);
    render(<Harness scrollHint={hint} save={save} />);
    const { user, dialog, form, input } = await open();
    await user.type(input, "공개 초안");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(input).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "저장 중" })).toBeDisabled();
    const target = within(dialog).getByText(hint);
    expect(target.closest("fieldset:disabled")).toBeNull();
    within(dialog).getByRole("button", { name: "대화상자 닫기" }).focus();
    await user.tab();
    expect(target).toHaveFocus();
    fireEvent.submit(form);
    await user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    expect(save).toHaveBeenCalledOnce();
    await act(async () => {
      release();
      await pending;
    });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "편집 열기" })).toHaveFocus();
  });

  it("읽기 안내를 선택해도 취소·폐기 보호와 원래 버튼 포커스를 유지한다", async () => {
    const save = vi.fn();
    render(<Harness scrollHint={hint} save={save} />);
    const { user, dialog, input } = await open();
    await user.type(input, "유지할 공개 초안");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await user.click(screen.getByRole("button", { name: "계속 편집" }));
    expect(input).toHaveValue("유지할 공개 초안");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await user.click(screen.getByRole("button", { name: "변경 버리기" }));
    expect(dialog).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "편집 열기" })).toHaveFocus();
    expect(save).not.toHaveBeenCalled();
  });
});
