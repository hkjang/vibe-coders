import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { Input } from "@/shared/components/ui/Input";
import { DataTable } from "@/shared/data-table/DataTable";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";

interface Person {
  id: string;
  name: string;
}

const personColumns = (() => {
  const helper = createDataTableColumnHelper<Person>();
  return helper.columns([helper.accessor("name", { header: "이름" })]) as Array<DataTableColumn<Person>>;
})();

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

  it("distinguishes empty, loading, and retryable error states", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const { rerender } = render(
      <DataTable caption="요청" columns={personColumns} data={[]} emptyMessage="요청이 없습니다." />,
    );
    expect(screen.getByText("요청이 없습니다.")).toBeInTheDocument();

    rerender(<DataTable caption="요청" columns={personColumns} data={[]} loading />);
    expect(screen.getByRole("status")).toHaveTextContent("불러오는 중");

    rerender(
      <DataTable caption="요청" columns={personColumns} data={[]} error="조회 실패" onRetry={retry} />,
    );
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
