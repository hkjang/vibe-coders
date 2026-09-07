import { AlertTriangle, RefreshCw } from "lucide-react";

import {
  sensitivityLabel,
  sensitivityTones,
  statusTones,
} from "@/features/text2sql/overview/text2sql-labels";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export function SensitivityBadge({ value }: { value: string }): React.JSX.Element {
  const normalised = value || "normal";
  return <Badge tone={sensitivityTones[normalised] ?? "muted"}>{sensitivityLabel(normalised)}</Badge>;
}

export function StatusBadge({ value }: { value: string }): React.JSX.Element {
  return <Badge tone={statusTones[value.toLowerCase()] ?? "muted"}>{value || "—"}</Badge>;
}

/**
 * Non-blocking failure of one panel: the last good data stays on screen and the
 * operator gets the request ID plus a retry.
 */
export function PanelFailure({
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
    <div className="t2s-panel-failure" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <strong>
          {label} {hasData ? "갱신에 실패해 마지막 정상 데이터를 표시합니다." : "조회에 실패했습니다."}
        </strong>
        <p>{safeAppErrorMessage(error, `${label} 데이터를 확인할 수 없습니다.`)}</p>
        {requestId ? <code>요청 ID: {requestId}</code> : null}
      </div>
      <Button size="small" variant="secondary" onClick={onRetry} aria-label={`${label} 재시도`}>
        <RefreshCw aria-hidden="true" /> 재시도
      </Button>
    </div>
  );
}

export function ReadOnlyNotice({ canWrite }: { canWrite: boolean }): React.JSX.Element | null {
  if (canWrite) return null;
  return (
    <p className="t2s-readonly-note" role="status">
      읽기 전용으로 열려 있습니다. 변경하려면 <code>admin:write</code> 권한이 필요합니다.
    </p>
  );
}
