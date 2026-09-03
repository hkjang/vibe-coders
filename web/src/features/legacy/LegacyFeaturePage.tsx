import { ArrowUpRight, Construction } from "lucide-react";

import type { MigrationFeature } from "@/config/migration-registry";
import { uiLabels } from "@/config/ui-labels";
import { Badge } from "@/shared/components/ui/Badge";

export function LegacyFeaturePage({ feature }: { feature: MigrationFeature }): React.JSX.Element {
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
        <p>신규 UI로 전환되기 전까지 동일한 데이터와 권한을 사용하는 기존 관리자 화면을 이용하세요.</p>
        <a className="button button-primary button-default" href={feature.legacyPath}>
          기존 화면에서 {feature.title} 열기 <ArrowUpRight aria-hidden="true" />
        </a>
      </section>
    </div>
  );
}
