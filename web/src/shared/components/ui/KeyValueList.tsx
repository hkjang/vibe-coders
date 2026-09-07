import type { ReactNode } from "react";

import { cn } from "@/shared/utils/cn";

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** Render the value in a monospace font (identifiers, paths, hashes). */
  mono?: boolean;
}

interface KeyValueListProps {
  className?: string;
  columns?: 1 | 2 | 3;
  items: ReadonlyArray<KeyValueItem>;
}

/** Definition list for detail views; empty values render as a dash. */
export function KeyValueList({ className, columns = 2, items }: KeyValueListProps): React.JSX.Element {
  return (
    <dl className={cn("kv-list", className)} data-columns={columns}>
      {items.map((item, index) => (
        <div key={index} className="kv-item">
          <dt>{item.label}</dt>
          <dd className={item.mono ? "mono" : undefined}>
            {item.value === undefined || item.value === null || item.value === "" ? "—" : item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
