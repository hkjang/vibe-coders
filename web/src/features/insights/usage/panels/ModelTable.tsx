import { categoryPaint } from "@/features/insights/charts/palette";
import type { WorkModelRow, WorkModelSuggestion } from "@/shared/api/domains/insights-usage";
import { Badge } from "@/shared/components/ui/Badge";
import { formatDuration, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

import { CategoryLabel, PlainTable, Suppressed, type PlainColumn } from "../usage-ui";

/** A measure of a model row; a withheld row reads as 보호됨 in every measure. */
type Measure = (row: WorkModelRow) => React.ReactNode;

function columnsFor(minGroupSize: number, compact: boolean): PlainColumn<WorkModelRow>[] {
  const measure =
    (write: Measure): Measure =>
    (row) =>
      row.suppressed ? <Suppressed minGroupSize={minGroupSize} /> : write(row);
  const base: PlainColumn<WorkModelRow>[] = [
    {
      id: "category",
      header: "업무",
      cell: (row) => (
        <CategoryLabel name={row.category.name || row.category.id} paint={categoryPaint(row.category.id)} />
      ),
    },
    {
      id: "model",
      header: "모델",
      cell: (row) => (
        <span className="wi-model-cell">
          <span className="mono">{row.model || "—"}</span>
          {row.low_sample && !row.suppressed ? (
            <Badge tone="warning" title="표본이 적어 비율과 지연 값이 크게 흔들릴 수 있습니다.">
              표본 적음
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      id: "share",
      header: "비중",
      numeric: true,
      help: "이 업무의 세션 중 이 모델이 처리한 비율",
      cell: measure((row) => formatPercent(row.share)),
    },
    { id: "sessions", header: "세션", numeric: true, cell: measure((row) => formatNumber(row.sessions)) },
    {
      id: "cost",
      header: "세션당 비용",
      numeric: true,
      cell: measure((row) => formatKRW(row.cost_per_session)),
    },
  ];
  if (compact) return base;

  const detail: PlainColumn<WorkModelRow>[] = [
    {
      id: "tokens",
      header: "세션당 토큰",
      numeric: true,
      cell: measure((row) => formatNumber(row.tokens_per_session)),
    },
    {
      id: "p50",
      header: "P50 지연",
      numeric: true,
      help: "지연 히스토그램에서 추정한 값",
      cell: measure((row) => formatDuration(row.latency_p50_ms)),
    },
    {
      id: "p95",
      header: "P95 지연",
      numeric: true,
      help: "지연 히스토그램에서 추정한 값",
      cell: measure((row) => formatDuration(row.latency_p95_ms)),
    },
    { id: "errors", header: "오류율", numeric: true, cell: measure((row) => formatPercent(row.error_rate)) },
    {
      id: "retries",
      header: "재시도율",
      numeric: true,
      cell: measure((row) => formatPercent(row.retry_rate)),
    },
    {
      id: "switches",
      header: "모델 전환율",
      numeric: true,
      help: "세션 도중 다른 모델로 바꾼 비율",
      cell: measure((row) => formatPercent(row.model_switch_rate)),
    },
    {
      id: "feedback",
      header: "피드백",
      numeric: true,
      help: "긍정 / 부정 피드백 건수",
      cell: measure(
        (row) => `긍정 ${formatNumber(row.feedback_positive)} · 부정 ${formatNumber(row.feedback_negative)}`,
      ),
    },
  ];
  return [...base, ...detail];
}

const rowKey = (row: WorkModelRow, index: number): string =>
  `${row.category.id}|${row.provider}|${row.model}|${index}`;

/** 업무 × 모델. The compact form is the summary's "모델·비용" table. */
export function ModelTable({
  rows,
  minGroupSize,
  compact = false,
}: {
  rows: readonly WorkModelRow[];
  minGroupSize: number;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <PlainTable
      caption={compact ? "업무별 모델과 비용 (상위)" : "업무별 모델 사용 현황"}
      columns={columnsFor(minGroupSize, compact)}
      rows={rows}
      rowKey={rowKey}
      wide={!compact}
      rowClassName={(row) => (row.low_sample && !row.suppressed ? "wi-row-low-sample" : undefined)}
    />
  );
}

/** Cheaper-model suggestions, each with the basis and sample it rests on. */
export function SuggestionList({
  suggestions,
}: {
  suggestions: readonly WorkModelSuggestion[];
}): React.JSX.Element {
  return (
    <ul className="wi-suggestion-list" aria-label="모델 변경 제안">
      {suggestions.map((item, index) => (
        <li
          key={`${item.category.id}-${item.from_model}-${item.to_model}-${index}`}
          className="wi-suggestion"
        >
          <strong>{item.category.name || item.category.id}</strong>
          <p>
            <span className="mono">{item.from_model}</span> → <span className="mono">{item.to_model}</span>
          </p>
          <dl className="wi-signal-facts">
            <div>
              <dt>근거</dt>
              <dd>{item.basis || "—"}</dd>
            </div>
            <div>
              <dt>표본</dt>
              <dd>{formatNumber(item.sample)}세션</dd>
            </div>
            <div>
              <dt>예상 절감 (추정)</dt>
              <dd>{formatKRW(item.est_saving_krw)}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}
