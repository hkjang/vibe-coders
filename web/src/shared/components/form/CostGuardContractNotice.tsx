import { useAuth } from "@/app/auth/AuthProvider";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { LegacyLink } from "@/shared/components/ui/LegacyLink";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { costGuardContractMessage, supportsCostGuardContract } from "@/shared/utils/cost-guard";

/** Compatibility applies only to this configuration, not all policy features. */
export function CostGuardContractNotice(): React.JSX.Element | null {
  const auth = useAuth();
  if (supportsCostGuardContract(auth.backendVersion)) return null;
  return (
    <InlineNotice tone="warning" title="비용 보호 설정의 서버 버전을 확인하세요.">
      <p>{costGuardContractMessage}</p>
      {canOpenLegacyAdmin(auth) ? (
        <LegacyLink href="/admin#/safety">기존 관리자에서 비용 보호 설정 열기</LegacyLink>
      ) : null}
    </InlineNotice>
  );
}
