import { ListFilter } from "lucide-react";
import { Link } from "react-router";

import { modelRowKey, type ModelCatalogRow } from "@/features/gateway/models/model-catalog";
import { modelSourceLabels } from "@/features/gateway/models/model-presentation";

interface ModelCandidateSelectionProps {
  candidates: readonly ModelCatalogRow[];
  detailSearch: (row: ModelCatalogRow) => string;
}

export function ModelCandidateSelection({
  candidates,
  detailSearch,
}: ModelCandidateSelectionProps): React.JSX.Element {
  return (
    <div className="model-detail-error" role="status">
      <ListFilter aria-hidden="true" />
      <div>
        <strong>공급자와 출처를 선택해 주세요.</strong>
        <p>동일한 모델 ID가 여러 카탈로그에 있어 하나를 자동으로 선택하지 않았습니다.</p>
        <ul>
          {candidates.map((candidate) => (
            <li key={modelRowKey(candidate.model)}>
              <Link to={{ search: detailSearch(candidate) }}>
                {candidate.providerLabel} · {modelSourceLabels[candidate.model.source]}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
