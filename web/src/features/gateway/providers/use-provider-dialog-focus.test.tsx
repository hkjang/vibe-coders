import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderDialogFocus } from "./use-provider-dialog-focus";

function Host() {
  const [selected, setSelected] = useState("");
  const focus = useProviderDialogFocus(selected, () => setSelected(""));
  return (
    <main id="main-content" tabIndex={-1}>
      <h2 id="provider-list-title" tabIndex={-1}>
        공급자 목록
      </h2>
      <button
        data-provider-trigger="fixture"
        onClick={(event) => {
          focus.rememberTrigger(event.currentTarget, "fixture");
          setSelected("fixture");
        }}
      >
        공급자 열기
      </button>
      <button onClick={focus.closeProvider}>상세 닫기</button>
      <input aria-label="검색 입력" />
      <button>다른 메뉴</button>
    </main>
  );
}
function close() {
  render(<Host />);
  const trigger = screen.getByRole("button", { name: "공급자 열기" });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "상세 닫기" }));
  return trigger;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});
describe("공급자 상세의 지연 초점 복원", () => {
  it.each(["검색 입력", "다른 메뉴"])("닫은 뒤 선택한 %s의 초점을 빼앗지 않는다", (label) => {
    close();
    const next =
      label === "검색 입력" ? screen.getByLabelText(label) : screen.getByRole("button", { name: label });
    next.focus();
    act(() => vi.runOnlyPendingTimers());
    expect(next).toHaveFocus();
  });
  it.each(["본문", "기본 콘텐츠", "목록 제목"])(
    "초점이 %s에 남으면 현재 목록의 트리거로 복원한다",
    (target) => {
      const trigger = close();
      if (target === "기본 콘텐츠") document.getElementById("main-content")?.focus();
      if (target === "목록 제목") document.getElementById("provider-list-title")?.focus();
      act(() => vi.runOnlyPendingTimers());
      expect(trigger).toHaveFocus();
    },
  );
});
