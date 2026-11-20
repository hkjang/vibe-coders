import { useAuth } from "@/app/auth/AuthProvider";
import { resolveLegacyFeatureHref } from "@/shared/permissions/legacy-feature";
import { FeatureLegacyLink } from "@/shared/components/ui/FeatureLegacyLink";

import { ArrowUpRight, Construction } from "lucide-react";

import type { MigrationFeature } from "@/config/migration-registry";
import { uiLabels } from "@/config/ui-labels";
import { Badge } from "@/shared/components/ui/Badge";

export function LegacyFeaturePage({ feature }: { feature: MigrationFeature }): React.JSX.Element {
  const auth = useAuth();
  const canOpen = resolveLegacyFeatureHref(auth, feature.featureId, feature.legacyPath) !== undefined;
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <div className="eyebrow">{uiLabels.legacyBridge}</div>
          <h1>{feature.title}</h1>
          <p>{feature.description}</p>
        </div>
        <Badge tone="warning">기존 화면</Badge>
      </header>
      <section className="legacy-card">
        <Construction aria-hidden="true" />
        <h2>이 기능은 안정 운영 화면에서 제공됩니다.</h2>
        <p>
          {canOpen
            ? "신규 UI로 전환되기 전까지 동일한 데이터와 권한을 사용하는 기존 관리자 화면을 이용하세요."
            : "기존 화면을 열 수 없습니다. 대상 기능의 전환 설정과 기존 관리자 접근 권한을 확인하세요."}
        </p>
        <FeatureLegacyLink
          featureId={feature.featureId}
          className="button button-primary button-default"
          href={feature.legacyPath}
        >
          기존 화면에서 {feature.title} 열기 <ArrowUpRight aria-hidden="true" />
        </FeatureLegacyLink>
      </section>
    </div>
  );
}
