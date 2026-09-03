import { AlertTriangle, RefreshCw } from "lucide-react";

import type { AdminModelPartialFailure } from "@/shared/api/schemas";
import { providerDisplayLabel } from "@/shared/api/provider-ref";
import { Button } from "@/shared/components/ui/Button";
import { operationalMessage } from "@/shared/errors/operational-messages";

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
            ? "공급자 갱신에 실패해 마지막 정상 모델을 표시합니다."
            : "공급자 모델 카탈로그를 확인할 수 없습니다."}
        </strong>
        <ul>
          {failures.map((failure) => (
            <li key={`${failure.provider_ref}-${failure.code}`}>
              {failure.provider ? `${providerDisplayLabel(failure.provider, failure.provider_ref)} · ` : ""}
              {operationalMessage(failure.code, "모델 카탈로그 일부를 확인할 수 없습니다.")} ({failure.code})
            </li>
          ))}
        </ul>
        {requestId ? <code>요청 ID: {requestId}</code> : null}
      </div>
      <Button
        size="small"
        variant="secondary"
        onClick={onRetry}
        disabled={fetching}
        aria-label="모델 카탈로그 상세 재시도"
      >
        <RefreshCw aria-hidden="true" /> {fetching ? "갱신 중" : "재시도"}
      </Button>
    </div>
  );
}
