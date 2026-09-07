import type { ReactNode } from "react";

import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatNumber } from "@/shared/utils/format";

export interface CostBar {
  label: string;
  value: number;
  display?: string;
  tone?: "default" | "warning" | "danger";
}

/** Cost bars drawn with tokens only; values stay readable as text. */
export function CostBars({ items, label }: { items: readonly CostBar[]; label: string }): React.JSX.Element {
  const max = items.reduce((peak, item) => Math.max(peak, item.value), 0);
  return (
    <dl className="finops-bars" aria-label={label}>
      {items.map((item) => (
        <div className="finops-bar-row" key={item.label}>
          <dt className="truncate" title={item.label}>
            {item.label}
          </dt>
          <dd>
            <span className="finops-bar-track">
              <span
                className="finops-bar-fill"
                data-tone={item.tone ?? "default"}
                style={{ width: `${max > 0 ? Math.max(2, Math.round((item.value / max) * 100)) : 0}%` }}
              />
            </span>
          </dd>
          <dd className="cell-number">{item.display ?? formatNumber(item.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Partial failure: keeps the last good data on screen and offers a retry. */
export function CostQueryFailure({
  error,
  hasData,
  label,
  onRetry,
}: {
  error: unknown;
  hasData: boolean;
  label: string;
  onRetry: () => void;
}): React.JSX.Element {
  const requestId = isAppError(error) ? error.requestId : undefined;
  return (
    <InlineNotice
      tone={hasData ? "warning" : "danger"}
      title={`${label}을(를) 불러오지 못했습니다.`}
      actions={
        <Button size="small" onClick={onRetry}>
          다시 시도
        </Button>
      }
    >
      {safeAppErrorMessage(error, "잠시 후 다시 시도해 주세요.")}
      {hasData ? " 마지막으로 확인한 값을 표시합니다." : ""}
      {requestId ? ` 요청 ID: ${requestId}` : ""}
    </InlineNotice>
  );
}

export function LegacyHint({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <InlineNotice tone="info" title="여기서 할 수 없는 작업">
      {children}
    </InlineNotice>
  );
}
