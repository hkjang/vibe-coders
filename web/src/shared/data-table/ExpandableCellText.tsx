import { ChevronDown } from "lucide-react";
import "./expandable-cell-text.css";

/** Long metadata stays compact; native disclosure makes the full value keyboard accessible. */
export function ExpandableCellText({ value, mono = false }: { value: string; mono?: boolean }) {
  if (value.length <= 64) return <span className={mono ? "mono" : undefined}>{value || "—"}</span>;
  return (
    <details className="data-table-expandable-text">
      <summary aria-label={`${value} 전체 내용 펼치기 또는 접기`}>
        <span className={mono ? "mono" : undefined}>{value}</span>
        <ChevronDown aria-hidden="true" />
      </summary>
    </details>
  );
}
