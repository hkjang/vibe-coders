import { ExternalLink } from "lucide-react";
import { Link } from "react-router";

import { categoryPaint } from "@/features/insights/charts/palette";
import type { WorkRequest } from "@/shared/api/domains/insights-common";
import type { WorkSessionRow } from "@/shared/api/domains/insights-usage";
import { Badge } from "@/shared/components/ui/Badge";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import {
  formatDateTime,
  formatDuration,
  formatKRW,
  formatNumber,
  formatPercent,
  shortId,
} from "@/shared/utils/format";

import {
  actionLabel,
  classificationLabel,
  classificationTone,
  completionLabel,
  completionTone,
  methodLabel,
  requestExplorerPath,
  sessionKindLabel,
  userText,
  workTitleText,
} from "./usage-labels";
import { CategoryLabel, WorkTitle } from "./usage-ui";

export function sessionColumns(): ReadonlyArray<DataTableColumn<WorkSessionRow>> {
  const column = createDataTableColumnHelper<WorkSessionRow>();
  return column.columns([
    column.accessor((row) => row.session_id, {
      id: "session",
      header: "세션",
      cell: ({ row }) => (
        <div>
          <span className="mono" title={row.original.session_id}>
            {shortId(row.original.session_id, 16)}
          </span>
          <div className="wi-cell-sub">{sessionKindLabel(row.original.session_kind)}</div>
        </div>
      ),
    }),
    column.accessor((row) => row.primary.name, {
      id: "primary",
      header: "주 업무",
      cell: ({ row }) => (
        <div>
          <CategoryLabel
            name={row.original.primary.name || row.original.primary.id}
            paint={categoryPaint(row.original.primary.id)}
          />
          {row.original.secondary.length > 0 ? (
            <div className="wi-cell-sub">
              함께: {row.original.secondary.map((item) => item.name || item.id).join(", ")}
            </div>
          ) : null}
        </div>
      ),
    }),
    column.accessor((row) => row.team, {
      id: "team",
      header: "조직",
      cell: ({ getValue }) => getValue() || "—",
    }),
    column.accessor((row) => row.user, {
      id: "user",
      header: "사용자",
      cell: ({ getValue }) => userText(getValue()),
    }),
    column.accessor((row) => row.client, {
      id: "client",
      header: "클라이언트",
      cell: ({ getValue }) => getValue() || "—",
    }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.cost_krw, {
      id: "cost_krw",
      header: "비용",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
    column.accessor((row) => row.duration_ms, {
      id: "duration_ms",
      header: "소요 시간",
      cell: ({ getValue }) => <span className="cell-number">{formatDuration(getValue())}</span>,
    }),
    column.accessor((row) => row.errors, {
      id: "errors",
      header: "오류",
      cell: ({ row }) => (
        <span className="cell-number">
          {formatNumber(row.original.errors)}
          {row.original.retries > 0 ? ` · 재시도 ${formatNumber(row.original.retries)}` : ""}
        </span>
      ),
    }),
    column.accessor((row) => row.models.join(", "), {
      id: "models",
      header: "모델",
      cell: ({ row }) => (
        <span className="mono" title={row.original.models.join(", ")}>
          {row.original.models[0] ?? "—"}
          {row.original.models.length > 1 ? ` 외 ${row.original.models.length - 1}` : ""}
        </span>
      ),
    }),
    column.accessor((row) => row.completion, {
      id: "completion",
      header: "완료 상태",
      cell: ({ getValue }) => <Badge tone={completionTone(getValue())}>{completionLabel(getValue())}</Badge>,
    }),
    column.accessor((row) => row.last_at, {
      id: "last_at",
      header: "마지막 활동",
      cell: ({ getValue }) => formatDateTime(getValue()),
    }),
  ]);
}

export function requestColumns(): ReadonlyArray<DataTableColumn<WorkRequest>> {
  const column = createDataTableColumnHelper<WorkRequest>();
  return column.columns([
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "시각",
      cell: ({ getValue }) => formatDateTime(getValue()),
    }),
    column.accessor((row) => row.category.name, {
      id: "category",
      header: "업무",
      cell: ({ row }) => (
        <CategoryLabel
          name={row.original.category.name || row.original.category.id}
          paint={categoryPaint(row.original.category.id)}
        />
      ),
    }),
    column.accessor((row) => row.action_type, {
      id: "action",
      header: "작업",
      cell: ({ getValue }) => actionLabel(getValue()),
    }),
    column.accessor((row) => workTitleText(row), {
      id: "title",
      header: "작업 제목",
      cell: ({ row }) => <WorkTitle request={row.original} />,
    }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "분류 상태",
      cell: ({ getValue }) => (
        <Badge tone={classificationTone(getValue())}>{classificationLabel(getValue())}</Badge>
      ),
    }),
    column.accessor((row) => row.confidence, {
      id: "confidence",
      header: "신뢰도",
      cell: ({ row }) => (
        <span className="cell-number">
          {formatPercent(row.original.confidence, 0)} · {methodLabel(row.original.method)}
        </span>
      ),
    }),
    column.accessor((row) => row.team, {
      id: "team",
      header: "조직",
      cell: ({ getValue }) => getValue() || "—",
    }),
    column.accessor((row) => row.user, {
      id: "user",
      header: "사용자",
      cell: ({ getValue }) => userText(getValue()),
    }),
    column.accessor((row) => row.model, {
      id: "model",
      header: "모델",
      cell: ({ getValue }) => <span className="mono">{getValue() || "—"}</span>,
    }),
    column.accessor((row) => row.tokens, {
      id: "tokens",
      header: "토큰",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.cost_krw, {
      id: "cost",
      header: "비용",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
    column.accessor((row) => row.latency_ms, {
      id: "latency",
      header: "지연",
      cell: ({ row }) => (
        <span className="cell-number">
          {formatDuration(row.original.latency_ms)}
          {row.original.is_error ? " · 오류" : ""}
        </span>
      ),
    }),
    column.display({
      id: "links",
      header: "열기",
      cell: ({ row }) => (
        <Link
          to={requestExplorerPath(row.original.request_id)}
          aria-label={`요청 ${row.original.request_id} 요청 탐색기에서 열기`}
        >
          요청 탐색기 <ExternalLink aria-hidden="true" />
        </Link>
      ),
    }),
  ]);
}
