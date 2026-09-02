import { ExternalLink, RefreshCw } from "lucide-react";

import { formatInteger } from "@/features/health/health-utils";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";

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
          <div className="eyebrow">Preview Read Only</div>
          <h1>Models</h1>
          <p>Provider별 Model 재고와 Model ID 기준 품질, 가격, 사용 지침을 함께 조회합니다.</p>
        </div>
        <div className="page-actions">
          <Badge tone="info">Read Only</Badge>
          {showLegacyAdmin ? (
            <a className="button button-secondary button-default" href="/admin#/model-contracts">
              Legacy에서 열기 <ExternalLink aria-hidden="true" />
            </a>
          ) : null}
          <Button variant="primary" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw aria-hidden="true" /> {refreshing ? "갱신 중" : "새로고침"}
          </Button>
          {refreshing ? (
            <span className="sr-only" role="status">
              Model 카탈로그를 갱신하고 있습니다.
            </span>
          ) : null}
        </div>
      </header>

      <section className="model-summary" aria-busy={loading || undefined} aria-label="Model 요약">
        <article>
          <span>전체 Model</span>
          <strong>{value(totalCount)}</strong>
        </article>
        <article>
          <span>Available</span>
          <strong>{value(availableCount)}</strong>
        </article>
        <article>
          <span>Virtual</span>
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
