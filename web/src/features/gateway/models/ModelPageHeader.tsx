import { ExternalLink, RefreshCw } from "lucide-react";

import { formatInteger } from "@/features/health/health-utils";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { uiLabels } from "@/config/ui-labels";

interface ModelPageHeaderProps {
  attentionCount: number;
  availableCount: number;
  catalogueAvailable: boolean;
  loading: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  showLegacyAdmin: boolean;
  totalCount: number;
  virtualCount: number;
}

export function ModelPageHeader({
  attentionCount,
  availableCount,
  catalogueAvailable,
  loading,
  onRefresh,
  refreshing,
  showLegacyAdmin,
  totalCount,
  virtualCount,
}: ModelPageHeaderProps): React.JSX.Element {
  const value = (count: number): string => (catalogueAvailable ? formatInteger(count) : "—");
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">{uiLabels.previewReadOnly}</div>
          <h1>모델</h1>
          <p>공급자별 모델 재고와 모델 ID 기준 품질, 가격, 사용 지침을 함께 조회합니다.</p>
        </div>
        <div className="page-actions">
          <Badge tone="info">{uiLabels.readOnly}</Badge>
          {showLegacyAdmin ? (
            <a className="button button-secondary button-default" href="/admin#/model-contracts">
              기존 화면에서 열기 <ExternalLink aria-hidden="true" />
            </a>
          ) : null}
          <Button variant="primary" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw aria-hidden="true" /> {refreshing ? "갱신 중" : "새로고침"}
          </Button>
          {refreshing ? (
            <span className="sr-only" role="status">
              모델 카탈로그를 갱신하고 있습니다.
            </span>
          ) : null}
        </div>
      </header>

      <section className="model-summary" aria-busy={loading || undefined} aria-label="모델 요약">
        <article>
          <span>전체 모델</span>
          <strong>{value(totalCount)}</strong>
        </article>
        <article>
          <span>사용 가능</span>
          <strong>{value(availableCount)}</strong>
        </article>
        <article>
          <span>가상</span>
          <strong>{value(virtualCount)}</strong>
        </article>
        <article>
          <span>확인 필요</span>
          <strong>{value(attentionCount)}</strong>
        </article>
      </section>
    </>
  );
}
