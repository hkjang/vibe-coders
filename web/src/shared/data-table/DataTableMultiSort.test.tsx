import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { DataTableSortControls } from "./DataTableSortControls";
import type { DataTableSort } from "./DataTable";

const columns = [
  { id: "quality", label: "품질", initialDirection: "desc" as const },
  { id: "price", label: "가격" },
  { id: "model", label: "모델" },
];
function setup(value: readonly DataTableSort[] = []) {
  const change = vi.fn();
  const view = render(<DataTableSortControls columns={columns} value={value} onChange={change} />);
  return {
    ...view,
    user: userEvent.setup(),
    change,
    update: (next: readonly DataTableSort[]) =>
      view.rerender(<DataTableSortControls columns={columns} value={next} onChange={change} />),
  };
}
it("여러 열을 중복 없이 추가하고 방향·우선순위를 적용한다", async () => {
  const c = setup();
  await c.user.click(screen.getByRole("button", { name: "다중 정렬" }));
  expect(screen.getByRole("dialog")).toHaveClass("dialog-content-scroll-body");
  await c.user.click(screen.getByRole("button", { name: "정렬 기준 추가" }));
  expect(screen.getByRole("combobox", { name: "1순위 정렬 열" })).toHaveFocus();
  expect(screen.getByRole("combobox", { name: "1순위 정렬 방향" })).toHaveValue("desc");
  await c.user.click(screen.getByRole("button", { name: "정렬 기준 추가" }));
  expect(
    within(screen.getByRole("combobox", { name: "2순위 정렬 열" })).queryByRole("option", { name: "품질" }),
  ).not.toBeInTheDocument();
  await c.user.selectOptions(screen.getByRole("combobox", { name: "2순위 정렬 방향" }), "desc");
  const up = screen.getByRole("button", { name: "2순위 기준을 위로 이동" });
  up.focus();
  await c.user.keyboard("{Enter}");
  expect(screen.getByRole("combobox", { name: "1순위 정렬 열" })).toHaveValue("price");
  expect(screen.getByRole("combobox", { name: "1순위 정렬 열" })).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent("가격 기준을 1순위");
  await c.user.click(screen.getByRole("button", { name: "정렬 적용" }));
  expect(c.change).toHaveBeenCalledExactlyOnceWith([
    { columnId: "price", direction: "desc" },
    { columnId: "quality", direction: "desc" },
  ]);
  expect(screen.getByRole("button", { name: "다중 정렬" })).toHaveFocus();
});
it("모든 열까지 추가하고 삭제 초점을 복구하며 취소는 적용하지 않는다", async () => {
  const c = setup();
  await c.user.click(screen.getByRole("button", { name: "다중 정렬" }));
  for (let i = 0; i < columns.length; i++)
    await c.user.click(screen.getByRole("button", { name: "정렬 기준 추가" }));
  expect(screen.getByRole("button", { name: "정렬 기준 추가" })).toBeDisabled();
  await c.user.click(screen.getByRole("button", { name: "2순위 기준 삭제" }));
  expect(screen.getByRole("combobox", { name: "2순위 정렬 열" })).toHaveFocus();
  await c.user.click(screen.getByRole("button", { name: "2순위 기준 삭제" }));
  await c.user.click(screen.getByRole("button", { name: "1순위 기준 삭제" }));
  expect(screen.getByRole("button", { name: "정렬 기준 추가" })).toHaveFocus();
  await c.user.keyboard("{Escape}");
  expect(c.change).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "다중 정렬" })).toHaveFocus();
});
it("바뀐 외부 정렬로 이전 초안을 다시 열거나 적용하지 않는다", async () => {
  const original: readonly DataTableSort[] = [{ columnId: "quality", direction: "asc" }];
  const c = setup(original);
  await c.user.click(screen.getByRole("button", { name: "다중 정렬" }));
  c.update([{ columnId: "price", direction: "asc" }]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  c.update(original);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(c.change).not.toHaveBeenCalled();
});
it("적용한 외부 상태가 바뀌어도 트리거 초점을 유지하고 빈 기준도 적용한다", async () => {
  function Controlled() {
    const [value, setValue] = useState<readonly DataTableSort[]>([]);
    return <DataTableSortControls columns={columns} value={value} onChange={setValue} />;
  }
  render(<Controlled />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "다중 정렬" }));
  await user.click(screen.getByRole("button", { name: "정렬 기준 추가" }));
  await user.click(screen.getByRole("button", { name: "정렬 적용" }));
  expect(screen.getByRole("button", { name: "다중 정렬" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("combobox", { name: "1순위 정렬 열" })).toHaveValue("quality");
  await user.click(screen.getByRole("button", { name: "1순위 기준 삭제" }));
  await user.click(screen.getByRole("button", { name: "정렬 적용" }));
  await user.click(screen.getByRole("button", { name: "다중 정렬" }));
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});
