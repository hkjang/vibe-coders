import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { Input } from "@/shared/components/ui/Input";
import { DataTable } from "@/shared/data-table/DataTable";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import {
  dataTablePreferenceStorageKey,
  loadDataTablePreferences,
  sanitizeDataTablePreferences,
} from "@/shared/data-table/table-preferences";

interface Person {
  id: string;
  name: string;
  role?: string;
  team?: string;
}

const personColumns = (() => {
  const helper = createDataTableColumnHelper<Person>();
  return helper.columns([helper.accessor("name", { header: "이름" })]) as Array<DataTableColumn<Person>>;
})();

const configurablePersonColumns = (() => {
  const helper = createDataTableColumnHelper<Person>();
  return helper.columns([
    helper.accessor("name", { header: "이름" }),
    helper.accessor("role", { header: "역할" }),
    helper.accessor("team", { header: "팀" }),
  ]) as Array<DataTableColumn<Person>>;
})();

const configurablePerson = {
  id: "user-1",
  name: "김운영",
  role: "관리자",
  team: "플랫폼",
} satisfies Person;

function DialogHarness(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={openerRef} onClick={() => setOpen(true)}>
        설정 열기
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={openerRef}
        title="연결 설정"
        description="저장 전에 연결을 확인하세요."
      >
        <Button>연결 테스트</Button>
      </Dialog>
    </>
  );
}

describe("foundation form, dialog, and table components", () => {
  it("connects persistent labels, helper text, and errors to the input", () => {
    render(
      <FormField
        label="Provider 이름"
        description="운영자에게 보이는 이름입니다."
        error="필수값입니다."
        required
      >
        {(controlProps) => <Input {...controlProps} />}
      </FormField>,
    );

    const input = screen.getByRole("textbox", { name: "Provider 이름" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-required", "true");
    const describedBy = input.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(describedBy).toHaveLength(2);
    expect(screen.getByRole("alert")).toHaveTextContent("필수값입니다.");
  });

  it("traps the dialog interaction and restores focus after Escape", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "설정 열기" });

    await user.click(opener);
    expect(screen.getByRole("dialog", { name: "연결 설정" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "연결 설정" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("renders rows, ignores nested actions, and drives server pagination", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const onPageChange = vi.fn();
    const columns = [
      ...personColumns,
      {
        id: "action",
        header: "작업",
        cell: () => <button type="button">행 작업</button>,
      },
    ] satisfies Array<DataTableColumn<Person>>;

    render(
      <DataTable
        caption="Provider"
        columns={columns}
        data={[{ id: "provider-1", name: "OpenAI" }]}
        getRowId={(row) => row.id}
        onRowClick={onRowClick}
        getRowActionLabel={(row) => `${row.name} 상세 열기`}
        pageCount={3}
        pageIndex={1}
        onPageChange={onPageChange}
      />,
    );

    await user.click(screen.getByText("OpenAI"));
    expect(onRowClick).toHaveBeenCalledWith({ id: "provider-1", name: "OpenAI" });
    await user.click(screen.getByRole("button", { name: "OpenAI 상세 열기" }));
    expect(onRowClick).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "행 작업" }));
    expect(onRowClick).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("keeps the legacy DOM contract when tableId is omitted", () => {
    render(<DataTable caption="기존 표" columns={personColumns} data={[{ id: "user-1", name: "김운영" }]} />);

    expect(screen.queryByRole("button", { name: "열 설정" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getByLabelText("기존 표 표 영역")).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("table", { name: "기존 표" })).not.toHaveAttribute("style");
  });

  it("distinguishes empty, loading, and retryable error states", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const { rerender } = render(
      <DataTable caption="요청" columns={personColumns} data={[]} emptyMessage="요청이 없습니다." />,
    );
    expect(screen.getByText("요청이 없습니다.")).toBeInTheDocument();

    rerender(<DataTable caption="요청" columns={personColumns} data={[]} loading />);
    expect(screen.getByRole("status")).toHaveTextContent("불러오는 중");
    expect(screen.getByRole("columnheader", { name: "이름" })).toBeInTheDocument();
    expect(document.querySelectorAll(".data-table-skeleton-row")).toHaveLength(5);

    rerender(
      <DataTable caption="요청" columns={personColumns} data={[]} error="조회 실패" onRetry={retry} />,
    );
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("sanitizes persisted layout metadata without retaining row or filter data", () => {
    const sanitized = sanitizeDataTablePreferences(
      {
        columnOrder: ["unknown", "team", "team", "name"],
        columnSizing: { name: 1, role: 900, team: Number.NaN, unknown: 200 },
        columnVisibility: { name: false, role: false, team: false, unknown: false },
        filters: [{ id: "name", value: "비밀" }],
        requestId: "req-secret",
        rows: [configurablePerson],
      },
      ["name", "role", "team"],
      ["name"],
    );

    expect(sanitized).toEqual({
      columnOrder: ["team", "name", "role"],
      columnSizing: { name: 80, role: 640 },
      columnVisibility: { role: false, team: false },
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/비밀|req-secret|김운영|unknown/u);
  });

  it("removes invalid preferences and rewrites valid records to the safe schema", () => {
    const storageKey = dataTablePreferenceStorageKey("people.storage-safety");
    window.localStorage.setItem(storageKey, "{invalid");
    expect(loadDataTablePreferences("people.storage-safety", ["name", "role"])).toEqual({
      columnOrder: ["name", "role"],
      columnSizing: {},
      columnVisibility: {},
    });
    expect(window.localStorage.getItem(storageKey)).toBeNull();

    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        columnOrder: ["role", "name"],
        columnSizing: {},
        columnVisibility: {},
        filters: [{ id: "name", value: "비밀" }],
        rows: [configurablePerson],
      }),
    );
    expect(loadDataTablePreferences("people.storage-safety", ["name", "role"]).columnOrder).toEqual([
      "role",
      "name",
    ]);
    expect(window.localStorage.getItem(storageKey)).not.toMatch(/비밀|김운영|rows|filters/u);

    window.localStorage.setItem(storageKey, JSON.stringify({ version: 0, rows: [configurablePerson] }));
    loadDataTablePreferences("people.storage-safety", ["name", "role"]);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it("renders valid loading rows when a table has no column definitions", () => {
    render(<DataTable<Person> caption="빈 정의" columns={[]} data={[]} loading />);

    const skeletonRows = document.querySelectorAll(".data-table-skeleton-row");
    expect(skeletonRows).toHaveLength(5);
    for (const row of skeletonRows) expect(row.querySelectorAll("td")).toHaveLength(1);
  });

  it("persists safe visibility and order settings, honors locks, and resets them", async () => {
    const user = userEvent.setup();
    const tableId = "people.operations";
    const storageKey = dataTablePreferenceStorageKey(tableId);
    const first = render(
      <DataTable
        caption="사용자"
        columns={configurablePersonColumns}
        data={[configurablePerson]}
        lockedColumnIds={["name"]}
        tableId={tableId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "열 설정" }));
    const dialog = screen.getByRole("dialog", { name: "표 열 설정" });
    expect(within(dialog).getByRole("checkbox", { name: /이름/u })).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /역할/u }));
    await user.click(within(dialog).getByRole("button", { name: "팀 열을 왼쪽으로 이동" }));
    await user.click(within(dialog).getByRole("button", { name: "설정 완료" }));

    expect(screen.queryByRole("columnheader", { name: "역할" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["이름", "팀"]);
    const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      "columnOrder",
      "columnSizing",
      "columnVisibility",
      "version",
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/김운영|관리자|플랫폼|user-1/u);

    first.unmount();
    render(
      <DataTable
        caption="사용자"
        columns={configurablePersonColumns}
        data={[configurablePerson]}
        lockedColumnIds={["name"]}
        tableId={tableId}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["이름", "팀"]);
    });

    await user.click(screen.getByRole("button", { name: "열 설정" }));
    await user.click(screen.getByRole("button", { name: "기본값으로 초기화" }));
    await user.click(screen.getByRole("button", { name: "설정 완료" }));
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "이름",
      "역할",
      "팀",
    ]);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it("keeps at least one column visible and resizes with keyboard and mouse", async () => {
    const user = userEvent.setup();
    const tableId = "people.resize";
    render(
      <DataTable
        caption="사용자"
        columns={configurablePersonColumns}
        data={[configurablePerson]}
        tableId={tableId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "열 설정" }));
    await user.click(screen.getByRole("checkbox", { name: /역할/u }));
    await user.click(screen.getByRole("checkbox", { name: /팀/u }));
    expect(screen.getByRole("checkbox", { name: /이름/u })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "설정 완료" }));

    const table = screen.getByRole("table", { name: "사용자" });
    expect(table).toHaveStyle({ minWidth: "160px", tableLayout: "fixed", width: "160px" });
    const separator = screen.getByRole("separator", { name: "이름 열 너비 조절" });
    separator.focus();
    await user.keyboard("{End}");
    expect(separator).toHaveAttribute("aria-valuenow", "640");
    expect(table).toHaveStyle({ minWidth: "640px", width: "640px" });
    await user.keyboard("{Home}");
    expect(separator).toHaveAttribute("aria-valuenow", "80");
    expect(table).toHaveStyle({ minWidth: "80px", width: "80px" });
    fireEvent.mouseDown(separator, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 220 });
    fireEvent.mouseUp(document, { clientX: 220 });
    await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "200"));
    expect(table).toHaveStyle({ minWidth: "200px", width: "200px" });

    const stored = JSON.parse(
      window.localStorage.getItem(dataTablePreferenceStorageKey(tableId)) ?? "{}",
    ) as { columnSizing?: Record<string, number> };
    expect(stored.columnSizing?.name).toBe(200);

    await user.dblClick(separator);
    expect(separator).toHaveAttribute("aria-valuenow", "160");
    expect(table).toHaveStyle({ minWidth: "160px", width: "160px" });
  });

  it("shows overflow guidance only when needed without ResizeObserver", async () => {
    const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
    Object.defineProperty(window, "ResizeObserver", { configurable: true, value: undefined });
    try {
      render(
        <DataTable
          caption="사용자"
          columns={configurablePersonColumns}
          data={[configurablePerson]}
          tableId="people.overflow"
        />,
      );
      const scrollRegion = screen.getByLabelText("사용자 표 영역");
      Object.defineProperties(scrollRegion, {
        clientWidth: { configurable: true, value: 320 },
        scrollLeft: { configurable: true, value: 0, writable: true },
        scrollWidth: { configurable: true, value: 900 },
      });
      fireEvent(window, new Event("resize"));

      expect(await screen.findByText("좌우로 이동해 추가 열 보기")).toBeInTheDocument();
      expect(scrollRegion).toHaveAttribute(
        "aria-label",
        "사용자 표 영역. 좌우로 스크롤하면 추가 열을 볼 수 있습니다.",
      );
      const frame = scrollRegion.parentElement;
      expect(frame).toHaveAttribute("data-at-start", "true");
      expect(frame).not.toHaveAttribute("data-at-end");
      scrollRegion.scrollLeft = 580;
      fireEvent.scroll(scrollRegion);
      expect(frame).not.toHaveAttribute("data-at-start");
      expect(frame).toHaveAttribute("data-at-end", "true");
    } finally {
      if (resizeObserverDescriptor) {
        Object.defineProperty(window, "ResizeObserver", resizeObserverDescriptor);
      } else {
        Reflect.deleteProperty(window, "ResizeObserver");
      }
    }
  });

  it("has no automated accessibility violations in configurable table controls", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DataTable
        caption="사용자"
        columns={configurablePersonColumns}
        data={[configurablePerson]}
        tableId="people.a11y"
      />,
    );
    await user.click(screen.getByRole("button", { name: "열 설정" }));
    expect((await axe.run(container.ownerDocument.body)).violations).toEqual([]);
  });
});
