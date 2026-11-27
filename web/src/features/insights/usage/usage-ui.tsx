import { ChevronRight, Inbox, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { DataQueryNotice } from "@/features/data/DataQueryNotice";
import { Swatch } from "@/features/insights/charts/chart-parts";
import type { CategoryPaint } from "@/features/insights/charts/palette";
import type { WorkMetricId, WorkRequest } from "@/shared/api/domains/insights-common";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";

import type { UsageRead } from "./use-usage-queries";
import { isUnavailable } from "./usage-errors";
import { withheldScopeText, workTitleFallbackHint, workTitleText } from "./usage-labels";
import { formatChange, formatMetric, suppressedHint, suppressedLabel } from "./usage-metrics";

interface PanelProps<Data> {
  query: UsageRead<Data>;
  /** Names the panel in its loading, failure and empty messages. */
  label: string;
  isEmpty?: (data: Data) => boolean;
  emptyHint?: string;
  /**
   * The server withheld the whole scope (too few users to show): its rows are
   * empty on purpose, which is not "no data". Checked before `isEmpty`.
   */
  withheld?: { when: (data: Data) => boolean; minGroupSize: number };
  children: (data: Data) => ReactNode;
}

/**
 * One panel's states, each looking different: a skeleton while it first loads,
 * a dashed box when the period has no data, a 보호됨 box when the server withheld
 * the scope, a notice when its read failed (with the last good data kept
 * underneath), and dimmed content while new filters load. A failure here never
 * affects another panel.
 */
export function Panel<Data>({
  query,
  label,
  isEmpty,
  emptyHint,
  withheld,
  children,
}: PanelProps<Data>): React.JSX.Element {
  const { data } = query;
  return (
    <div
      className="wi-panel"
      aria-busy={query.isFetching || undefined}
      data-previous={query.isPrevious || undefined}
    >
      {query.isError ? (
        isUnavailable(query.error) ? (
          <InlineNotice tone="info" title={`${label}: 이 서버에서 아직 제공하지 않습니다.`}>
            업무 활용 분석 API가 꺼져 있거나 서버 버전이 낮습니다. 서버를 업그레이드하거나 설정을 확인하세요.
          </InlineNotice>
        ) : (
          <DataQueryNotice
            error={query.error}
            hasPreviousData={data !== undefined}
            label={label}
            onRetry={query.refetch}
          />
        )
      ) : null}
      {data !== undefined ? (
        withheld?.when(data) ? (
          <PanelWithheld label={label} minGroupSize={withheld.minGroupSize} />
        ) : isEmpty?.(data) ? (
          <PanelEmpty label={label} hint={emptyHint} />
        ) : (
          children(data)
        )
      ) : query.isPending ? (
        <div className="wi-panel-skeleton" role="status">
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line" />
          <span className="sr-only">{label} 불러오는 중입니다.</span>
        </div>
      ) : null}
    </div>
  );
}

export function PanelEmpty({ label, hint }: { label: string; hint?: string }): React.JSX.Element {
  return (
    <div className="wi-panel-empty" role="status">
      <Inbox aria-hidden="true" />
      <p>
        <strong>{label}: 선택한 기간과 필터에 해당하는 데이터가 없습니다.</strong>
        <span>{hint ?? "기간을 넓히거나 필터를 줄여 보세요."}</span>
      </p>
    </div>
  );
}

/** The server withheld the whole scope: there is data, it is just too small a group to show. */
export function PanelWithheld({
  label,
  minGroupSize,
}: {
  label: string;
  minGroupSize: number;
}): React.JSX.Element {
  return (
    <div className="wi-panel-empty" role="status" data-withheld="true">
      <ShieldCheck aria-hidden="true" />
      <p>
        <strong>
          {label}: <Suppressed minGroupSize={minGroupSize} />
        </strong>
        <span>{withheldScopeText}</span>
      </p>
    </div>
  );
}

/** A withheld value. The reason is in the tooltip and in the scope line above the tabs. */
export function Suppressed({ minGroupSize }: { minGroupSize: number }): React.JSX.Element {
  return (
    <span className="wi-suppressed" title={suppressedHint(minGroupSize)}>
      {suppressedLabel}
    </span>
  );
}

/** A request's work title, or its category name in muted text when there is no title. */
export function WorkTitle({
  request,
}: {
  request: Pick<WorkRequest, "work_title" | "category">;
}): React.JSX.Element {
  if (request.work_title) return <>{request.work_title}</>;
  const text = workTitleText(request);
  return text === "—" ? (
    <>{text}</>
  ) : (
    <span className="wi-title-fallback" title={workTitleFallbackHint}>
      {text}
    </span>
  );
}

export function MetricValue({
  value,
  metric,
  minGroupSize,
}: {
  value: number | null | undefined;
  metric: WorkMetricId;
  minGroupSize: number;
}): React.JSX.Element {
  if (value === null) return <Suppressed minGroupSize={minGroupSize} />;
  return <>{formatMetric(value, metric)}</>;
}

/** Change from the previous period as text with an arrow; never colour alone. */
export function Change({ rate }: { rate: number | null | undefined }): React.JSX.Element {
  return <span className="wi-change">{formatChange(rate)}</span>;
}

export function CategoryLabel({ name, paint }: { name: string; paint: CategoryPaint }): React.JSX.Element {
  return (
    <span className="wi-category-label">
      <Swatch paint={paint} />
      <span>{name}</span>
    </span>
  );
}

interface KpiTileProps {
  label: string;
  value: ReactNode;
  /** The previous-period comparison, or why there is none. */
  comparison: ReactNode;
  /** Query string of the tab that explains this number. */
  to: string;
  linkLabel: string;
}

/** A headline number with its comparison and a link into the tab behind it. */
export function KpiTile({ label, value, comparison, to, linkLabel }: KpiTileProps): React.JSX.Element {
  return (
    <article className="stat-card wi-kpi" aria-label={label}>
      <div className="stat-card-label">
        <span>{label}</span>
      </div>
      <strong className="stat-card-value">{value}</strong>
      <span className="stat-card-hint">{comparison}</span>
      <Link className="wi-kpi-link" to={{ search: to }} aria-label={`${label}: ${linkLabel}`}>
        {linkLabel}
        <ChevronRight aria-hidden="true" />
      </Link>
    </article>
  );
}

export interface PlainColumn<Row> {
  id: string;
  header: ReactNode;
  /** Explains the column; shown as the header's tooltip. */
  help?: string;
  numeric?: boolean;
  cell: (row: Row) => ReactNode;
}

interface PlainTableProps<Row> {
  caption: string;
  columns: readonly PlainColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row, index: number) => string;
  rowClassName?: (row: Row) => string | undefined;
  /** Many columns: say earlier that the table scrolls sideways. */
  wide?: boolean;
}

/** A read-only table for a panel: the first column is the row header. */
export function PlainTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  rowClassName,
  wide = false,
}: PlainTableProps<Row>): React.JSX.Element {
  return (
    <div className="wi-table-wrap" data-wide={wide ? "true" : undefined}>
      <div className="data-table-scroll" tabIndex={0} role="region" aria-label={`${caption} 표 영역`}>
        <table className="data-table data-table-auto wi-table">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  title={column.help}
                  className={column.numeric ? "wi-cell-number" : undefined}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={rowKey(row, index)} className={rowClassName?.(row)}>
                {columns.map((column, columnIndex) =>
                  columnIndex === 0 ? (
                    <th key={column.id} scope="row">
                      {column.cell(row)}
                    </th>
                  ) : (
                    <td key={column.id} className={column.numeric ? "wi-cell-number" : undefined}>
                      {column.cell(row)}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="wi-table-hint" aria-hidden="true">
        좌우로 스크롤하면 나머지 열을 볼 수 있습니다.
      </p>
    </div>
  );
}
