import type { WorkMetricId } from "@/shared/api/domains/insights-common";
import type { WorkSignal } from "@/shared/api/domains/insights-usage";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { formatNumber } from "@/shared/utils/format";

import { signalKindLabel } from "../usage-labels";
import { formatChange, formatMetric, formatSigned, suppressedLabel } from "../usage-metrics";

interface SignalListProps {
  signals: readonly WorkSignal[];
  metric: WorkMetricId;
  label: string;
  /** Print the signal kind on each row (for lists that mix kinds). */
  showKind?: boolean;
  onOpen: (signal: WorkSignal) => void;
}

const users = (value: number | null): string =>
  value === null ? suppressedLabel : `${formatNumber(value)}명`;

/**
 * Trend signals with the numbers behind them: where the value was, where it is,
 * the absolute and relative change, how the user count moved and the sample.
 */
export function SignalList({
  signals,
  metric,
  label,
  showKind = false,
  onOpen,
}: SignalListProps): React.JSX.Element {
  return (
    <ul className="wi-signal-list" aria-label={label}>
      {signals.map((signal, index) => {
        const context = [signal.team ? `조직 ${signal.team}` : "", signal.model ? `모델 ${signal.model}` : ""]
          .filter(Boolean)
          .join(" · ");
        return (
          <li
            key={`${signal.kind}-${signal.category.id}-${signal.team}-${signal.model}-${index}`}
            className="wi-signal"
          >
            <div className="wi-signal-head">
              <strong>{signal.category.name || signal.category.id}</strong>
              {showKind ? <Badge tone="info">{signalKindLabel(signal.kind)}</Badge> : null}
              {context ? <span className="wi-signal-context">{context}</span> : null}
            </div>
            <dl className="wi-signal-facts">
              <div>
                <dt>이번 기간</dt>
                <dd>{formatMetric(signal.current, metric)}</dd>
              </div>
              <div>
                <dt>직전 기간</dt>
                <dd>{formatMetric(signal.previous, metric)}</dd>
              </div>
              <div>
                <dt>절대 증감</dt>
                <dd>{formatSigned(signal.change_abs, metric)}</dd>
              </div>
              <div>
                <dt>증감률</dt>
                <dd>{signal.change_rate === null ? "비교 기준 없음" : formatChange(signal.change_rate)}</dd>
              </div>
              <div>
                <dt>사용자</dt>
                <dd>
                  {users(signal.users_previous)} → {users(signal.users_current)}
                </dd>
              </div>
              <div>
                <dt>표본</dt>
                <dd>{formatNumber(signal.sample)}건</dd>
              </div>
            </dl>
            {signal.note ? <p className="wi-signal-note">{signal.note}</p> : null}
            <Button
              size="small"
              variant="ghost"
              aria-label={`${signal.category.name || signal.category.id} 세션 보기`}
              onClick={() => onOpen(signal)}
            >
              세션 보기
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
