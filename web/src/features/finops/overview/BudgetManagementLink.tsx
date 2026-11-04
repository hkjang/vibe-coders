import { Link } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { migrationRegistry, resolveFeature } from "@/config/migration-registry";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { LegacyLink } from "@/shared/components/ui/LegacyLink";

/** Resolve the destination independently of the current costs permission. */
export function BudgetManagementLink(): React.JSX.Element {
  const auth = useAuth();
  const feature =
    auth.features.find((item) => item.featureId === "access.users") ??
    migrationRegistry.find((item) => item.featureId === "access.users");
  const effective = feature
    ? resolveFeature(feature, auth.user, auth.backendVersion, { legacyFallback: auth.legacyFallback })
    : undefined;
  const permitted = effective?.permitted && (!auth.user || auth.user.scopes.includes("admin:read"));
  return (
    <InlineNotice tone="info" title="예산 관리 안내">
      이 탭은 예산 소진 예측과 비용 이상 신호를 조회합니다. 예산 등록·삭제는 별도의 관리 화면에서 변경 권한을
      확인한 뒤 진행합니다.{" "}
      {permitted && effective?.status !== "hidden" ? (
        effective?.status === "legacy" ? (
          <LegacyLink className="finops-budget-link" href={feature?.legacyPath}>
            기존 사용자·팀 관리 열기
          </LegacyLink>
        ) : (
          <Link className="finops-budget-link" to="/access/users?tab=quotas">
            할당량·예산 관리 열기
          </Link>
        )
      ) : (
        <span>예산 관리 화면에 접근하려면 운영자에게 권한과 기능 공개 상태를 확인해 주세요.</span>
      )}
    </InlineNotice>
  );
}
