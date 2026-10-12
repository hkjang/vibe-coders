import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { DataTable } from "./DataTable";
import { createDataTableColumnHelper } from "./columns";

const helper = createDataTableColumnHelper<{ priority: number }>();
const columns = helper.columns([helper.accessor("priority", { header: "장애 전환 / 우선순위" })]);

it("uses an optional sort name without renaming the visible header or resize control", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <DataTable
      caption="공급자 정렬"
      columns={columns}
      data={[{ priority: 10 }, { priority: 0 }]}
      tableId="test.provider-sort-label"
      sorting={{ columns: [{ id: "priority", sortLabel: "우선순위" }], onChange }}
    />,
  );
  const button = screen.getByRole("button", { name: "우선순위 오름차순 정렬" });
  expect(button).toHaveTextContent("장애 전환 / 우선순위");
  expect(screen.getByRole("separator", { name: "장애 전환 / 우선순위 열 너비 조절" })).toBeInTheDocument();
  button.focus();
  await user.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ columnId: "priority", direction: "asc" });
  expect(screen.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["10", "0"]);
});

it("keeps the original heading name for callers without an override", () => {
  render(
    <DataTable
      caption="기존 정렬"
      columns={columns}
      data={[]}
      sorting={{ columns: [{ id: "priority" }], onChange: vi.fn() }}
    />,
  );
  expect(screen.getByRole("button", { name: "장애 전환 / 우선순위 오름차순 정렬" })).toBeInTheDocument();
});
