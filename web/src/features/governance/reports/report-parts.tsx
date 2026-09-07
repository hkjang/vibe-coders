import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatNumber } from "@/shared/utils/format";

export interface BarDatum {
  label: string;
  value: number;
  display?: string;
}

/**
 * Horizontal bars drawn as inline SVG (the legacy console has no chart library).
 * The bars are decorative — the same numbers always appear in the table beside
 * them — so each row exposes its value as text instead of as graphics.
 */
export function ScoreBars({ data, max }: { data: readonly BarDatum[]; max?: number }): React.JSX.Element {
  const ceiling = Math.max(max ?? 0, ...data.map((item) => item.value), 1);
  return (
    <div className="gov-bars">
      {data.map((item) => {
        const ratio = Math.max(0, Math.min(1, item.value / ceiling));
        return (
          <div className="gov-bars-row" key={item.label}>
            <span className="gov-bars-label" title={item.label}>
              {item.label}
            </span>
            <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <rect x="0" y="0" width="100" height="10" rx="2" fill="var(--color-muted-soft)" />
              <rect
                x="0"
                y="0"
                width={Math.max(ratio * 100, ratio > 0 ? 1 : 0)}
                height="10"
                rx="2"
                fill="var(--color-primary)"
              />
            </svg>
            <span className="gov-bars-value">{item.display ?? formatNumber(item.value)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Warns that one panel failed while the rest of the screen keeps its last good data. */
export function PanelFailure({
  error,
  label,
  onRetry,
}: {
  error: unknown;
  label: string;
  onRetry?: () => void;
}): React.JSX.Element {
  const requestId = isAppError(error) ? error.requestId : undefined;
  return (
    <InlineNotice
      tone="warning"
      title={`${label}을(를) 불러오지 못했습니다.`}
      actions={
        onRetry ? (
          <Button size="small" onClick={onRetry}>
            다시 시도
          </Button>
        ) : undefined
      }
    >
      {safeAppErrorMessage(error, "잠시 후 다시 시도하세요.")}
      {requestId ? ` (요청 ID: ${requestId})` : ""}
    </InlineNotice>
  );
}

/** Renders a short list of labels as badges, or a dash when the list is empty. */
export function BadgeList({
  items,
  tone = "muted",
}: {
  items: readonly string[];
  tone?: "danger" | "muted" | "warning";
}): React.JSX.Element {
  if (items.length === 0) return <>—</>;
  return (
    <ul className="gov-chip-list">
      {items.map((item) => (
        <li key={item}>
          <Badge tone={tone}>{item}</Badge>
        </li>
      ))}
    </ul>
  );
}
