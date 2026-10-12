import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { DataTable, type DataTableSort } from "./DataTable";
import { createDataTableColumnHelper } from "./columns";

interface Item {
  id: string;
  quality: number;
}
const helper = createDataTableColumnHelper<Item>();
const columns = helper.columns([
  helper.accessor("id", { header: "모델" }),
  helper.accessor("quality", { header: "품질" }),
]);
const rows: Item[] = [
  { id: "second", quality: 20 },
  { id: "first", quality: 10 },
];

function ControlledTable({ onSort }: { onSort: (sort: DataTableSort) => void }): React.JSX.Element {
  const [sort, setSort] = useState<DataTableSort>();
  return (
    <DataTable
      caption="선택적 정렬"
      columns={columns}
      data={rows}
      tableId="test.sort-controls"
      sorting={{
        columns: [{ id: "id" }, { id: "quality", initialDirection: "desc" }],
        value: sort,
        onChange: (next) => {
          onSort(next);
          setSort(next);
        },
      }}
    />
  );
}

describe("optional controlled data table sorting", () => {
  it("does not add sort or page-size controls for existing callers", () => {
    render(<DataTable caption="기존 목록" columns={columns} data={rows} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("페이지당 표시 건수")).not.toBeInTheDocument();
    expect(document.querySelector("[aria-sort]")).toBeNull();
    expect(
      screen
        .getAllByRole("row")
        .slice(1)
        .map((entry) => entry.textContent),
    ).toEqual(["second20", "first10"]);
  });

  it("uses keyboard buttons and one aria-sort without reordering caller-provided rows", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(<ControlledTable onSort={onSort} />);
    const quality = screen.getByRole("button", { name: "품질 내림차순 정렬" });
    quality.focus();
    await user.keyboard("{Enter}");
    expect(onSort).toHaveBeenLastCalledWith({ columnId: "quality", direction: "desc" });
    expect(quality.closest("th")).toHaveAttribute("aria-sort", "descending");
    await user.keyboard(" ");
    expect(onSort).toHaveBeenLastCalledWith({ columnId: "quality", direction: "asc" });
    expect(quality.closest("th")).toHaveAttribute("aria-sort", "ascending");
    await user.click(screen.getByRole("button", { name: "모델 오름차순 정렬" }));
    expect(document.querySelectorAll("[aria-sort]")).toHaveLength(1);
    expect(quality.closest("th")).not.toHaveAttribute("aria-sort");
    expect(
      screen
        .getAllByRole("row")
        .slice(1)
        .map((entry) => entry.textContent),
    ).toEqual(["second20", "first10"]);
  });

  it("keeps keyboard resizing independent of sorting and labels a one-page size selector", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    const onSize = vi.fn();
    render(
      <DataTable
        caption="크기 선택"
        columns={columns}
        data={rows}
        tableId="test.sort-resize"
        sorting={{ columns: [{ id: "quality" }], onChange: onSort }}
        pageSizeControl={{ value: 10, options: [10, 25, 50], onChange: onSize }}
      />,
    );
    const resizer = screen.getByRole("separator", { name: "품질 열 너비 조절" });
    const width = Number(resizer.getAttribute("aria-valuenow"));
    resizer.focus();
    await user.keyboard("{ArrowRight}");
    expect(Number(resizer.getAttribute("aria-valuenow"))).toBeGreaterThan(width);
    expect(onSort).not.toHaveBeenCalled();
    const select = screen.getByRole("combobox", { name: "페이지당 표시 건수" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["10건", "25건", "50건"]);
    await user.selectOptions(select, "25");
    expect(onSize).toHaveBeenCalledExactlyOnceWith(25);
    expect(screen.queryByRole("button", { name: "다음" })).not.toBeInTheDocument();
    expect(onSort).not.toHaveBeenCalled();
  });
});
