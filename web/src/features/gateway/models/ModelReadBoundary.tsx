import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/shared/components/ui/Button";
import { useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { ModelReadContext } from "./model-read-owner";

export function ModelReadBoundary({ children }: { children: ReactNode }): React.JSX.Element {
  const owner = useFeatureReadOwner("gateway.models", "model-read-owner");
  const unavailable = !owner.readable || owner.denied;
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (unavailable) notice.current?.focus();
  }, [unavailable]);
  if (unavailable)
    return (
      <div className="page-stack" ref={notice} role="alert" tabIndex={-1}>
        <h1>모델 조회 권한 확인 필요</h1>
        <p>현재 계정의 모델 조회 권한을 확인할 수 없어 이전 목록과 입력 내용을 표시하지 않습니다.</p>
        <p>관리자에게 admin:read 권한과 모델 기능 접근 설정을 확인해 달라고 요청하세요.</p>
        {owner.readable ? <Button onClick={owner.restart}>권한 확인 후 다시 조회</Button> : null}
      </div>
    );
  return (
    <ModelReadContext.Provider key={owner.id} value={owner}>
      {children}
    </ModelReadContext.Provider>
  );
}
