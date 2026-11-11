import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/shared/components/ui/Button";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { regressionId } from "./regression-model";

export function RegressionBoundary({ children }: { children: (owner: FeatureReadOwner) => ReactNode }) {
  const owner = useFeatureReadOwner(regressionId, "golden-regression-read");
  const denied = !owner.readable || owner.denied;
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (denied) notice.current?.focus();
  }, [denied]);
  if (denied)
    return (
      <div ref={notice} className="page-stack" role="alert" tabIndex={-1}>
        <h1>회귀 검증 조회 권한 확인 필요</h1>
        <p>현재 계정의 조회 권한을 확인할 수 없어 이전 세트와 결과를 표시하지 않습니다.</p>
        <p>관리자에게 admin:read 권한과 회귀 검증 기능 접근 설정을 확인해 달라고 요청하세요.</p>
        {owner.readable ? <Button onClick={owner.restart}>권한 확인 후 다시 조회</Button> : null}
      </div>
    );
  return <div key={owner.id}>{children(owner)}</div>;
}
