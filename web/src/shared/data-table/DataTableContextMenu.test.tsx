import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StrictMode, useRef, useState } from "react";
import { Dialog } from "@/shared/components/ui/Dialog";
import { Sheet } from "@/shared/components/ui/Sheet";
import { DataTable } from "./DataTable";
import { createDataTableColumnHelper } from "./columns";

interface Item {
  id: string;
  name: string;
}
const helper = createDataTableColumnHelper<Item>();
const columns = helper.columns([
  helper.accessor("name", { header: "이름" }),
  helper.display({
    id: "controls",
    header: "기존 작업",
    cell: ({ row }) => (
      <>
        <a href="#existing">{row.original.name} 링크</a>
        <input aria-label={`${row.original.name} 입력`} />
        <button type="button">{row.original.name} 별도 작업</button>
      </>
    ),
  }),
]);
const initial: [Item, Item] = [
  { id: "a", name: "첫 항목" },
  { id: "b", name: "둘째 항목" },
];
function setup(strict = false) {
  const onAction = vi.fn();
  const view = (data: Item[] = initial, enabled = true, loading = false, error?: string) => (
    <DataTable
      caption="행 작업 검사"
      columns={columns}
      data={data}
      getRowId={(row) => row.id}
      loading={loading}
      error={error}
      {...(enabled
        ? { onRowClick: onAction, getRowActionLabel: (row: Item) => `${row.name} 상세 열기` }
        : { onRowClick: undefined, getRowActionLabel: undefined })}
    />
  );
  const container = (child: React.ReactNode) => {
    const content = (
      <main id="main-content" tabIndex={-1}>
        {child}
      </main>
    );
    return strict ? <StrictMode>{content}</StrictMode> : content;
  };
  const rendered = render(container(view()));
  return {
    user: userEvent.setup(),
    onAction,
    update: (data: Item[] = initial, enabled = true, loading = false, error?: string) =>
      rendered.rerender(container(view(data, enabled, loading, error))),
    cell: () => screen.getByRole("cell", { name: "첫 항목" }),
    button: () => screen.getByRole("button", { name: "첫 항목 상세 열기" }),
  };
}
// jsdom has no top layer. Browser tests cover actual popover dismissal/positioning.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "showPopover", {
    configurable: true,
    value: function (this: HTMLElement) {
      this.style.display = "block";
    },
  });
});
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
});

it("개발 StrictMode의 효과 재연결 뒤에도 열린 메뉴의 초점을 유지한다", async () => {
  const c = setup(true);
  fireEvent.contextMenu(c.cell());
  const item = await screen.findByRole("menuitem", { name: "첫 항목 상세 열기" });
  await waitFor(() => expect(item).toHaveFocus());
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(c.onAction).not.toHaveBeenCalled();
});

it("오른쪽 클릭은 기존 행 작업만 표시하고 선택할 때 한 번 실행한다", async () => {
  const c = setup();
  expect(fireEvent.contextMenu(c.cell(), { clientX: 40, clientY: 60 })).toBe(false);
  const menu = await screen.findByRole("menu", { name: "행 작업" });
  expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
  expect(c.onAction).not.toHaveBeenCalled();
  let returnTarget: Element | null = null;
  c.onAction.mockImplementation(() => {
    returnTarget = document.activeElement;
  });
  await c.user.click(within(menu).getByRole("menuitem", { name: "첫 항목 상세 열기" }));
  expect(c.onAction).toHaveBeenCalledExactlyOnceWith(initial[0]);
  expect(returnTarget).toBe(c.button());
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it.each(["Shift+F10", "ContextMenu"])("%s로 열고 Escape로 닫으면 행 버튼으로 돌아온다", async (key) => {
  const c = setup();
  c.button().focus();
  fireEvent.keyDown(c.button(), {
    key: key === "ContextMenu" ? key : "F10",
    shiftKey: key !== "ContextMenu",
  });
  await screen.findByRole("menu");
  await c.user.keyboard("{Escape}");
  await waitFor(() => expect(c.button()).toHaveFocus());
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(c.onAction).not.toHaveBeenCalled();
});

it("기존 행 클릭·상세 버튼·링크·별도 버튼을 중복 실행하지 않는다", async () => {
  const c = setup();
  await c.user.click(c.cell());
  await c.user.click(c.button());
  await c.user.click(screen.getByRole("button", { name: "첫 항목 별도 작업" }));
  await c.user.click(screen.getByRole("link", { name: "첫 항목 링크" }));
  expect(c.onAction).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("링크·입력·별도 버튼·열 제목의 브라우저 메뉴를 막지 않는다", () => {
  const c = setup();
  for (const target of [
    screen.getByRole("link", { name: "첫 항목 링크" }),
    screen.getByRole("textbox", { name: "첫 항목 입력" }),
    screen.getByRole("button", { name: "첫 항목 별도 작업" }),
    screen.getByRole("columnheader", { name: "이름" }),
  ])
    expect(fireEvent.contextMenu(target)).toBe(true);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(c.onAction).not.toHaveBeenCalled();
});

it("선택한 표 텍스트는 기본 복사 메뉴를 유지한다", () => {
  const c = setup();
  const range = document.createRange();
  range.selectNodeContents(c.cell());
  document.getSelection()?.addRange(range);
  expect(document.getSelection()?.toString()).toBe("첫 항목");
  expect(fireEvent.contextMenu(c.cell())).toBe(true);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it.each(["changed", "removed", "loading", "error", "permission"])(
  "%s 전환은 열린 메뉴를 폐기하며 되돌려도 다시 열지 않는다",
  async (mode) => {
    const c = setup();
    fireEvent.contextMenu(c.cell());
    await screen.findByRole("menu");
    if (mode === "changed") c.update([{ ...initial[0], name: "바뀐 항목" }, initial[1]]);
    if (mode === "removed") c.update([initial[1]]);
    if (mode === "loading") c.update(initial, true, true);
    if (mode === "error") c.update(initial, true, false, "조회 실패");
    if (mode === "permission") c.update(initial, false);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    if (mode === "removed" || mode === "loading" || mode === "permission")
      await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
    c.update();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(c.onAction).not.toHaveBeenCalled();
  },
);

it("행 작업이 없는 표에는 새 메뉴를 만들지 않는다", () => {
  const c = setup();
  c.update(initial, false);
  expect(fireEvent.contextMenu(c.cell())).toBe(true);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(c.onAction).not.toHaveBeenCalled();
});

it("상위 레이어를 지원하지 않는 브라우저는 기본 메뉴와 기존 상세 버튼을 유지한다", async () => {
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  const c = setup();
  expect(fireEvent.contextMenu(c.cell())).toBe(true);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  await c.user.click(c.button());
  expect(c.onAction).toHaveBeenCalledExactlyOnceWith(initial[0]);
});

it("목록을 같은 작업 안에서 바꿨다가 복원해도 폐기한 메뉴를 되살리지 않는다", async () => {
  const c = setup();
  fireEvent.contextMenu(c.cell());
  await screen.findByRole("menu");
  c.update([{ ...initial[0], name: "바뀐 항목" }, initial[1]]);
  c.update();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(c.onAction).not.toHaveBeenCalled();
});

it.each([Dialog, Sheet])(
  "상세 창 안의 행 메뉴는 Escape 한 번으로 바깥 창까지 닫지 않는다 (%#)",
  async (Container) => {
    function Fixture() {
      const [open, setOpen] = useState(true);
      const trigger = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={trigger} onClick={() => setOpen(true)}>
            바깥 창 열기
          </button>
          <Container
            open={open}
            onOpenChange={setOpen}
            returnFocusRef={trigger}
            title="바깥 상세"
            description="중첩 행 작업 검사"
          >
            <DataTable
              caption="중첩 표"
              columns={columns}
              data={initial}
              getRowActionLabel={(r) => `${r.name} 상세`}
              onRowClick={() => undefined}
            />
          </Container>
        </>
      );
    }
    render(<Fixture />);
    const button = screen.getByRole("button", { name: "첫 항목 상세" });
    button.focus();
    fireEvent.keyDown(button, { key: "F10", shiftKey: true });
    await screen.findByRole("menu");
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "바깥 상세" })).toBeInTheDocument();
    expect(button).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  },
);
