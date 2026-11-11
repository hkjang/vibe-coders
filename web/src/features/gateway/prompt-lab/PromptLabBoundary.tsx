import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/shared/components/ui/Button";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { promptLabRouteId } from "./use-prompt-lab";

export function PromptLabBoundary({ children }: { children: (owner: FeatureReadOwner) => ReactNode }) {
  const owner = useFeatureReadOwner(promptLabRouteId, "prompt-lab-read");
  const denied = !owner.readable || owner.denied;
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (denied) notice.current?.focus();
  }, [denied]);
  if (denied)
    return (
      <div ref={notice} className="page-stack" role="alert" tabIndex={-1}>
        <h1>프롬프트 실험실 조회 권한 확인 필요</h1>
        <p>현재 계정의 조회 권한을 확인할 수 없어 이전 실험과 결과를 표시하지 않습니다.</p>
        <p>관리자에게 admin:read 권한과 프롬프트 실험실 접근 설정을 확인해 달라고 요청하세요.</p>
        {owner.readable ? <Button onClick={owner.restart}>권한 확인 후 다시 조회</Button> : null}
      </div>
    );
  return <div key={owner.id}>{children(owner)}</div>;
}
