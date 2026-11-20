import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ExpandableCodeValue } from "./ExpandableCodeValue";

describe("ExpandableCodeValue", () => {
  it("bounds the initial DOM, preserves surrogate pairs, and expands by keyboard", async () => {
    const text = "가".repeat(2047) + "😀" + "긴 값".repeat(100_000) + "끝부분";
    const user = userEvent.setup();
    render(<ExpandableCodeValue text={text} label="요청 프롬프트 현재 값" />);
    const value = screen.getByLabelText("요청 프롬프트 현재 값");
    expect(value.textContent).toBe("가".repeat(2047));
    expect(value).toHaveAccessibleDescription("긴 값의 앞부분만 표시하고 있습니다.");
    const button = screen.getByRole("button", { name: "요청 프롬프트 현재 값 전체 펼치기" });
    expect(button).toHaveAttribute("aria-controls", value.id);
    await user.tab();
    expect(value).toHaveFocus();
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(value.textContent).toBe(text);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(value).not.toHaveAttribute("aria-describedby");
    await user.keyboard("{Enter}");
    expect(value.textContent).toHaveLength(2047);
  });

  it("collapses a changed value and never carries expansion back to a previous review", async () => {
    const first = "첫째".repeat(2048),
      second = "둘째".repeat(2048);
    const user = userEvent.setup();
    const view = render(<ExpandableCodeValue text={first} label="현재 값" />);
    await user.click(screen.getByRole("button"));
    view.rerender(<ExpandableCodeValue text={second} label="현재 값" />);
    expect(screen.getByLabelText("현재 값").textContent).toHaveLength(2048);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    view.rerender(<ExpandableCodeValue text={first} label="현재 값" />);
    expect(screen.getByLabelText("현재 값").textContent).toHaveLength(2048);
  });

  it.each(["", "가".repeat(2048), "<script>alert('text')</script>"])(
    "renders a short value as literal text without expansion",
    (text) => {
      const view = render(<ExpandableCodeValue text={text} label="적용 후 값" />);
      expect(screen.getByLabelText("적용 후 값").textContent).toBe(text);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(view.container.querySelector("script")).toBeNull();
    },
  );
});
