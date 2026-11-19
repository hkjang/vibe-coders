import { useAuth } from "@/app/auth/AuthProvider";
import { migrationRegistry } from "@/config/migration-registry";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { FeatureLegacyLink } from "@/shared/components/ui/FeatureLegacyLink";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";

const legacyPath = migrationRegistry.find((feature) => feature.featureId === "security.redteam")?.legacyPath;
export function EvidenceVersionNotice() {
  const auth = useAuth();
  return (
    <InlineNotice tone="info" title="증적 조회를 위해 서버 업그레이드가 필요합니다.">
      <p>기본 마스킹과 원문 조회 권한 확인은 서버 v0.86.146 이상에서 사용할 수 있습니다.</p>
      {legacyPath && canOpenLegacyAdmin(auth) ? (
        <FeatureLegacyLink
          featureId="security.redteam"
          className="button button-secondary button-default"
          href={legacyPath}
        >
          기존 화면에서 확인
        </FeatureLegacyLink>
      ) : null}
    </InlineNotice>
  );
}
