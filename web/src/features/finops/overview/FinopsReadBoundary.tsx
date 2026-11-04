import { Fragment, type ReactNode } from "react";
import { ErrorState, PermissionDenied } from "@/shared/components/state/PageStates";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";

export function FinopsReadBoundary({
  scope,
  children,
}: {
  scope: string;
  children: (owner: FeatureReadOwner) => ReactNode;
}): React.JSX.Element {
  const owner = useFeatureReadOwner("finops.overview", `finops-${scope}`, ["costs:read"]);
  if (!owner.readable) return <PermissionDenied permission="admin:read" />;
  if (owner.denied)
    return (
      <ErrorState
        title="비용 조회 권한을 다시 확인하세요."
        message="이전 조회 결과와 내보내기를 표시하지 않습니다."
        onRetry={owner.restart}
        showLegacy={false}
      />
    );
  return <Fragment key={owner.id}>{children(owner)}</Fragment>;
}
