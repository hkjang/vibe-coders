import type { ReactNode, RefCallback, RefObject } from "react";

export interface VirtualRowAttributes {
  ref: RefCallback<HTMLTableRowElement>;
  "data-index": number;
  "aria-rowindex": number;
}

export interface VirtualTableBodyProps {
  rowKeys: readonly string[];
  columnCount: number;
  headerRowCount: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  layoutVersion: string;
  renderRow: (index: number, attributes?: VirtualRowAttributes) => ReactNode;
}
