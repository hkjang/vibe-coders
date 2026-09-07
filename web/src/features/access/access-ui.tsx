import type { ReactNode } from "react";

import type { Tone } from "@/features/access/access-format";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime } from "@/shared/utils/format";

interface QueryNoticeProps {
  error: unknown;
  hasData: boolean;
  label: string;
  onRetry: () => void;
}

/** Partial failure banner: keeps the last good data visible and offers a retry. */
export function QueryNotice({ error, hasData, label, onRetry }: QueryNoticeProps): React.JSX.Element {
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
      {safeAppErrorMessage(error, "잠시 후 다시 시도하세요.")}
      {hasData ? " 마지막으로 확인된 값을 표시합니다." : null}
      {requestId ? <span className="request-id"> 요청 ID: {requestId}</span> : null}
    </InlineNotice>
  );
}

export function UpdatedAt({ at }: { at: number | undefined }): React.JSX.Element | null {
  if (!at) return null;
  return <p className="updated-at">마지막 갱신 {formatDateTime(at)}</p>;
}

export function ScopeBadges({ scopes }: { scopes: readonly string[] }): React.JSX.Element {
  if (scopes.length === 0) return <span className="access-note">역할 스코프를 상속합니다.</span>;
  return (
    <span className="badge-list">
      {scopes.map((scope) => (
        <Badge key={scope} tone="muted">
          {scope}
        </Badge>
      ))}
    </span>
  );
}

export function ToneBadge({ tone, children }: { tone: Tone; children: ReactNode }): React.JSX.Element {
  return <Badge tone={tone}>{children}</Badge>;
}

/** Horizontal usage meter for quota and budget consumption. */
export function UsageMeter({ ratio, label }: { ratio: number; label: string }): React.JSX.Element {
  const clamped = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
  const tone = clamped >= 1 ? "danger" : clamped >= 0.8 ? "warning" : "default";
  return (
    <span
      className="access-meter"
      data-tone={tone}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
    >
      <span style={{ width: `${String(Math.round(clamped * 100))}%` }} />
    </span>
  );
}
