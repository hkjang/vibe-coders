import { useState } from "react";
import type { WorkflowRunReceipt } from "@/shared/api/domains/agents.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { DataTable } from "@/shared/data-table/DataTable";
import { formatNumber } from "@/shared/utils/format";
import { displayColumn } from "../table-columns";
import { runState } from "../receipts/run-receipt";
import { flowType } from "./workflow-flow";

type Step = NonNullable<WorkflowRunReceipt["steps"]>[number];
type Row = { step: Step; index: number };
const columns = [
  displayColumn<Row>("index", "단계", ({ step }) =>
    Number.isSafeInteger(step.step_index) && (step.step_index ?? -1) >= 0
      ? formatNumber((step.step_index ?? 0) + 1)
      : "—",
  ),
  displayColumn<Row>("name", "이름", ({ step }) => step.name || "—"),
  displayColumn<Row>("type", "종류", ({ step }) => flowType(step)),
  displayColumn<Row>("status", "상태", ({ step }) => (
    <Badge tone={runState(step.status).tone}>{runState(step.status).label}</Badge>
  )),
  displayColumn<Row>("output_chars", "출력 길이 (문자)", ({ step }) =>
    Number.isSafeInteger(step.output_chars) && (step.output_chars ?? -1) >= 0
      ? formatNumber(step.output_chars ?? 0)
      : "—",
  ),
];

export function WorkflowReceiptSteps({ steps }: { steps: readonly Step[] }) {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(25);
  const count = Math.max(1, Math.ceil(steps.length / size));
  const current = Math.min(page, count - 1);
  const start = current * size;
  return (
    <section aria-label="기록된 단계 결과">
      <p>기록된 단계 {formatNumber(steps.length)}개</p>
      <DataTable
        caption="워크플로 실행 단계별 결과"
        columns={columns}
        data={steps.slice(start, start + size).map((step, index) => ({ step, index: start + index }))}
        getRowId={(row) => String(row.index)}
        pageIndex={current}
        pageCount={count}
        onPageChange={setPage}
        pageSizeControl={{
          value: size,
          options: [10, 25, 50],
          onChange: (value) => {
            setSize(value);
            setPage(0);
          },
        }}
        tableId="workflow-receipt-steps"
      />
    </section>
  );
}
