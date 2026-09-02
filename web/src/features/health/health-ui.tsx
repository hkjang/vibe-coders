import { AlertTriangle, Clock3, RefreshCw, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { exactTime, healthRanges, relativeTime, type HealthRange } from "@/features/health/health-utils";
import { isAppError } from "@/shared/api/error";
import { Badge, type BadgeProps } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";

const rangeLabels: Record<HealthRange, string> = {
  "1h": "1시간",
  "24h": "24시간",
  "7d": "7일",
  "30d": "30일",
};

export function TimeRangePicker({
  value,
  onChange,
}: {
  value: HealthRange;
  onChange: (range: HealthRange) => void;
}): React.JSX.Element {
  return (
    <div className="range-picker" role="group" aria-label="조회 기간">
      {healthRanges.map((range) => (
        <button key={range} type="button" aria-pressed={range === value} onClick={() => onChange(range)}>
          {rangeLabels[range]}
        </button>
      ))}
    </div>
  );
}

export function UpdatedTime({
  timestamp,
  label = "마지막 갱신",
}: {
  timestamp: number;
  label?: string;
}): React.JSX.Element {
  const exact = exactTime(timestamp);
  return (
    <time dateTime={new Date(timestamp).toISOString()} title={exact}>
      <Clock3 aria-hidden="true" /> {label} {relativeTime(timestamp)}
    </time>
  );
}

interface HealthWidgetProps {
  title: string;
  description?: string;
  icon: LucideIcon;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  updatedAt?: number;
  status?: string;
  statusTone?: BadgeProps["tone"];
  children?: ReactNode;
}

export function HealthWidget({
  title,
  description,
  icon: Icon,
  loading = false,
  error,
  onRetry,
  updatedAt,
  status,
  statusTone = "muted",
  children,
}: HealthWidgetProps): React.JSX.Element {
  const requestId = isAppError(error) ? error.requestId : undefined;
  const lastUpdatedAt = updatedAt ?? 0;
  const hasPreviousData = lastUpdatedAt > 0;
  const showInitialLoading = loading && !hasPreviousData;
  const showTerminalError = Boolean(error) && !hasPreviousData;
  return (
    <article className="health-widget" aria-busy={showInitialLoading || undefined}>
      <header className="health-widget-header">
        <span className="health-widget-icon" aria-hidden="true">
          <Icon />
        </span>
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {status ? <Badge tone={statusTone}>{status}</Badge> : null}
      </header>
      {showInitialLoading ? (
        <div className="widget-skeleton" role="status" aria-live="polite">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="sr-only">{title} 데이터를 불러오는 중입니다.</span>
        </div>
      ) : showTerminalError ? (
        <div className="widget-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>이 영역을 불러오지 못했습니다.</strong>
            <p>{isAppError(error) ? error.message : "잠시 후 다시 시도해 주세요."}</p>
            {requestId ? <code>Request ID: {requestId}</code> : null}
          </div>
          {onRetry ? (
            <Button size="small" variant="secondary" aria-label={`${title} 재시도`} onClick={onRetry}>
              <RefreshCw aria-hidden="true" /> 재시도
            </Button>
          ) : null}
        </div>
      ) : null}
      {error && hasPreviousData ? (
        <div className="widget-stale" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>새 갱신에 실패해 마지막 정상 데이터를 표시합니다.</strong>
            <p>{isAppError(error) ? error.message : "잠시 후 다시 시도해 주세요."}</p>
            {requestId ? <code>Request ID: {requestId}</code> : null}
          </div>
          {onRetry ? (
            <Button size="small" variant="secondary" aria-label={`${title} 재시도`} onClick={onRetry}>
              <RefreshCw aria-hidden="true" /> 재시도
            </Button>
          ) : null}
        </div>
      ) : null}
      {!showInitialLoading && !showTerminalError ? (
        <div className="health-widget-body">{children}</div>
      ) : null}
      {hasPreviousData && !showInitialLoading ? (
        <footer className="health-widget-footer">
          <UpdatedTime timestamp={lastUpdatedAt} label={error ? "마지막 정상 갱신" : undefined} />
        </footer>
      ) : null}
    </article>
  );
}
