import type { AlertEvent } from "@/shared/api/domains/governance";
import { Badge } from "@/shared/components/ui/Badge";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import type { GovernanceColumn } from "./governance-parts";
import { metricLabels } from "./alert-rule-form";

export const alertEventColumns: ReadonlyArray<GovernanceColumn<AlertEvent>> = [
  { id: "created_at", header: "시각", cell: (row) => formatDateTime(row.created_at) },
  { id: "rule", header: "규칙", cell: (row) => row.rule_name || row.rule_id || "—" },
  { id: "metric", header: "지표", cell: (row) => metricLabels.get(row.metric ?? "") ?? row.metric ?? "—" },
  {
    id: "value",
    header: "값",
    cell: (row) => <span className="cell-number">{formatNumber(row.value, 2)}</span>,
  },
  {
    id: "threshold",
    header: "임계값",
    cell: (row) => <span className="cell-number">{formatNumber(row.threshold, 2)}</span>,
  },
  {
    id: "delivered",
    header: "전송",
    cell: (row) =>
      row.delivered ? (
        <Badge tone="success">성공</Badge>
      ) : row.delivery_error ? (
        <Badge tone="danger" title={row.delivery_error}>
          실패
        </Badge>
      ) : (
        <Badge tone="muted">웹훅 없음</Badge>
      ),
  },
];
