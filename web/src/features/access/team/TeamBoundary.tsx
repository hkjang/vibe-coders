import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/shared/components/ui/Button";
import { useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { TeamContext, type TeamScope } from "./team-context";
export function TeamBoundary({ children, ...scope }: Omit<TeamScope, "owner"> & { children: ReactNode }) {
  const owner = useFeatureReadOwner("team.home", "team-home-read", ["admin:read"], "team:read");
  const notice = useRef<HTMLDivElement>(null);
  const denied = !owner.readable || owner.denied;
  useEffect(() => {
    if (denied) notice.current?.focus();
  }, [denied]);
  if (denied)
    return (
      <div ref={notice} role="alert" tabIndex={-1} className="page-stack">
        <h1>팀 조회 권한이 없습니다.</h1>
        <p>
          현재 계정의 team:read 권한과 팀 화면 접근 설정을 확인하세요. 이전 팀 데이터는 표시하지 않습니다.
        </p>
        {owner.readable ? <Button onClick={owner.restart}>권한 확인 후 다시 조회</Button> : null}
      </div>
    );
  return (
    <TeamContext.Provider key={owner.id} value={{ ...scope, owner }}>
      {children}
    </TeamContext.Provider>
  );
}
