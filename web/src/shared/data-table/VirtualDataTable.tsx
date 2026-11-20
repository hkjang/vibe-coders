import { useEffect, useState, type ComponentType } from "react";
import type { RowData } from "@tanstack/react-table";
import { DataTable, type DataTableProps } from "./DataTable";
import type { VirtualTableBodyProps } from "./virtual-table-types";
import { TableStateCell } from "./TableStateCell";
import { Button } from "@/shared/components/ui/Button";
import "./virtual-table.css";

function VirtualBodyLoader(props: VirtualTableBodyProps) {
  const [Body, setBody] = useState<ComponentType<VirtualTableBodyProps>>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void import("./VirtualTableBody")
      .then((module) => {
        if (current) setBody(() => module.VirtualTableBody);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, []);
  if (Body) return <Body {...props} />;
  return (
    <tbody>
      <tr>
        <TableStateCell colSpan={props.columnCount} error={failed}>
          <span role="status">
            {failed ? "목록을 표시하지 못했습니다. 화면을 새로고침해 주세요." : "목록을 준비하는 중입니다."}
          </span>
          {failed ? (
            <Button size="small" onClick={() => window.location.reload()}>
              새로고침
            </Button>
          ) : null}
        </TableStateCell>
      </tr>
    </tbody>
  );
}

/** Supplied records and server pagination stay intact; only large row DOMs are windowed. */
export function VirtualDataTable<TData extends RowData>(props: DataTableProps<TData>) {
  return <DataTable {...props} virtualRows={props.data.length > 100 ? VirtualBodyLoader : undefined} />;
}
