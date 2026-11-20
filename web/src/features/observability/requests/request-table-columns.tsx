import type { AppRequestSummary } from "@/shared/api/schemas";
import type { DataTableColumn } from "@/shared/data-table/columns";
import { Badge } from "@/shared/components/ui/Badge";
import { httpStatusTone } from "@/shared/utils/http-status";
import { RequestCost } from "./RequestCost";
import { formatRequestDate } from "./request-date";

export const requestTableId = "observability.requests";
export const requestLockedColumns = ["created_at", "request_id"] as const;

export function requestTableColumns(timeZone: string): DataTableColumn<AppRequestSummary>[] {
  return [
    {
      id: "created_at",
      header: "시각",
      accessorKey: "created_at",
      size: 224,
      cell: ({ row }) => (
        <time
          data-testid={`request-created-at-${row.original.request_id}`}
          dateTime={row.original.created_at}
        >
          {formatRequestDate(row.original.created_at, timeZone, { dateStyle: "short", timeStyle: "medium" })}
        </time>
      ),
    },
    {
      id: "status_code",
      header: "상태",
      accessorKey: "status_code",
      size: 80,
      cell: ({ row }) => (
        <Badge tone={httpStatusTone(row.original.status_code)}>{row.original.status_code}</Badge>
      ),
    },
    {
      id: "request_id",
      header: "요청 ID",
      accessorKey: "request_id",
      size: 160,
      cell: ({ row }) => <code>{row.original.request_id}</code>,
    },
    {
      id: "model",
      header: "모델",
      accessorKey: "model",
      size: 144,
      cell: ({ row }) => row.original.model || "-",
    },
    { id: "provider_display", header: "공급자", accessorKey: "provider_display", size: 144 },
    {
      id: "latency_ms",
      header: "지연",
      meta: {
        help: {
          unit: "ms",
          description:
            "게이트웨이에 기록된 요청 처리 시간입니다. 1,000밀리초(ms)는 1초이며, 첫 응답 조각까지의 시간과는 다릅니다.",
        },
      },
      accessorKey: "latency_ms",
      size: 144,
      cell: ({ row }) => `${row.original.latency_ms.toLocaleString("ko-KR")}ms`,
    },
    {
      id: "total_tokens",
      header: "토큰",
      meta: {
        help: {
          unit: "개",
          description:
            "요청 사용량에 기록된 전체 토큰 수입니다. 캐시·추론 토큰을 여기에 다시 더하지 않으며, 사용량 기록이 없으면 0으로 표시합니다.",
        },
      },
      accessorKey: "total_tokens",
      size: 136,
      cell: ({ row }) => row.original.total_tokens.toLocaleString("ko-KR"),
    },
    {
      id: "estimated_cost",
      header: "비용",
      meta: {
        help: {
          description:
            "요청에 기록된 추정 금액과 해당 통화를 표시합니다. 통화 간 환산이나 합산을 하지 않으며, 통화 정보가 없으면 미확인으로 표시합니다.",
        },
      },
      accessorKey: "estimated_cost",
      size: 128,
      cell: ({ row }) => <RequestCost value={row.original.estimated_cost} currency={row.original.currency} />,
    },
  ];
}
