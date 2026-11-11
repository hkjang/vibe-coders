import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/shared/components/ui/Button";
import { useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { LibraryOwnerContext } from "./library-context";
import { libraryRouteId } from "./library-model";

export function LibraryBoundary({ children }: { children: ReactNode }) {
  const owner = useFeatureReadOwner(libraryRouteId, "prompt-library-read");
  const denied = !owner.readable || owner.denied;
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (denied) notice.current?.focus();
  }, [denied]);
  if (denied)
    return (
      <div ref={notice} role="alert" tabIndex={-1} className="page-stack">
        <h1>프롬프트 보관함 조회 권한 확인 필요</h1>
        <p>계정의 조회 권한을 확인할 수 없어 이전 검색 결과와 자산을 표시하지 않습니다.</p>
        <p>관리자에게 admin:read 권한과 프롬프트 보관함 접근 설정을 확인해 달라고 요청하세요.</p>
        {owner.readable ? <Button onClick={owner.restart}>권한 확인 후 다시 조회</Button> : null}
      </div>
    );
  return (
    <LibraryOwnerContext.Provider key={owner.id} value={owner}>
      {children}
    </LibraryOwnerContext.Provider>
  );
}
