import { AlertTriangle, RefreshCw } from "lucide-react";

import type { AdminModelPartialFailure } from "@/shared/api/schemas";
import { providerDisplayLabel } from "@/shared/api/provider-ref";
import { Button } from "@/shared/components/ui/Button";

interface ModelCatalogueFailureProps {
  failures: readonly AdminModelPartialFailure[];
  fetching: boolean;
  onRetry: () => void;
  requestId: string;
  stale: boolean;
}

export function ModelCatalogueFailure({
  failures,
  fetching,
  onRetry,
  requestId,
  stale,
}: ModelCatalogueFailureProps): React.JSX.Element | null {
  if (failures.length === 0) return null;
  return (
    <div className="model-detail-query-state model-detail-query-warning" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <strong>
          {stale
            ? "Provider 갱신에 실패해 마지막 정상 Model을 표시합니다."
            : "Provider Model 카탈로그를 확인할 수 없습니다."}
        </strong>
        <ul>
          {failures.map((failure) => (
            <li key={`${failure.provider_ref}-${failure.code}`}>
              {failure.provider ? `${providerDisplayLabel(failure.provider, failure.provider_ref)} · ` : ""}
              {failure.message} ({failure.code})
            </li>
          ))}
        </ul>
        {requestId ? <code>Request ID: {requestId}</code> : null}
      </div>
      <Button
        size="small"
        variant="secondary"
        onClick={onRetry}
        disabled={fetching}
        aria-label="Model 카탈로그 상세 재시도"
      >
        <RefreshCw aria-hidden="true" /> {fetching ? "갱신 중" : "재시도"}
      </Button>
    </div>
  );
}
