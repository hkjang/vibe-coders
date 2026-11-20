import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { DataTable } from "./DataTable";
import { DataTableHeaderContent } from "./DataTableColumnHelp";
import { createDataTableColumnHelper } from "./columns";

const help = { unit: "ms", description: "1,000밀리초는 1초입니다. 첫 응답 조각까지의 시간과는 다릅니다." };

it("opens a described tooltip on keyboard focus and dismisses Escape without moving focus", async () => {
  const user = userEvent.setup();
  render(
    <>
      <DataTableHeaderContent label="지연" help={help}>
        지연
      </DataTableHeaderContent>
      <button>다음 작업</button>
    </>,
  );
  await user.tab();
  const button = screen.getByRole("button", { name: "지연 열 설명" });
  expect(button).toHaveFocus();
  await waitFor(() => expect(screen.getByRole("tooltip")).toHaveClass("data-table-column-help"));
  expect(screen.getByRole("tooltip")).toHaveTextContent(help.description);
  expect(button).toHaveAccessibleDescription(`지연 · ms ${help.description}`);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("tooltip")).toBeVisible();
  await user.tab();
  expect(screen.getByRole("button", { name: "다음 작업" })).toHaveFocus();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("keeps hover help readable while crossing to its text and closes after leaving both", async () => {
  render(
    <DataTableHeaderContent label="지연" help={help}>
      지연
    </DataTableHeaderContent>,
  );
  const button = screen.getByRole("button", { name: "지연 열 설명" });
  fireEvent.pointerEnter(button, { pointerType: "mouse" });
  await waitFor(() => expect(screen.getByRole("tooltip")).toHaveClass("data-table-column-help"));
  vi.useFakeTimers();
  try {
    const tip = screen.getByRole("tooltip");
    fireEvent.pointerLeave(button);
    fireEvent.pointerEnter(tip);
    act(() => vi.advanceTimersByTime(200));
    expect(tip).toBeVisible();
    fireEvent.pointerLeave(tip);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a clicked explanation open until a second click or an outside action", async () => {
  const user = userEvent.setup();
  render(
    <>
      <DataTableHeaderContent label="지연" help={help}>
        지연
      </DataTableHeaderContent>
      <button>바깥 작업</button>
    </>,
  );
  const button = screen.getByRole("button", { name: "지연 열 설명" });
  await user.click(button);
  await user.unhover(button);
  expect(screen.getByRole("tooltip")).toBeVisible();
  await user.click(button);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await user.click(button);
  await user.click(screen.getByRole("button", { name: "바깥 작업" }));
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("keeps explanation, sort and resize actions independent without changing data", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const helper = createDataTableColumnHelper<{ latency: number }>();
  render(
    <DataTable
      caption="요청 시간"
      headerContent={DataTableHeaderContent}
      tableId="test.column-help"
      data={[{ latency: 1250 }]}
      columns={helper.columns([helper.accessor("latency", { header: "지연", meta: { help } })])}
      sorting={{ columns: [{ id: "latency" }], onChange }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "지연 열 설명" }));
  expect(onChange).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "지연 오름차순 정렬" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ columnId: "latency", direction: "asc" });
  const resize = screen.getByRole("separator", { name: "지연 열 너비 조절" });
  resize.focus();
  await user.keyboard("{ArrowRight}");
  expect(resize).toHaveAttribute("aria-valuenow", "176");
  expect(screen.getByRole("cell")).toHaveTextContent("1250");
});

it("removes visible help when a column unmounts and adds no controls without metadata", async () => {
  const user = userEvent.setup();
  const view = render(
    <DataTableHeaderContent label="지연" help={help}>
      지연
    </DataTableHeaderContent>,
  );
  await user.click(screen.getByRole("button", { name: "지연 열 설명" }));
  view.rerender(<DataTableHeaderContent label="이름">이름</DataTableHeaderContent>);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
