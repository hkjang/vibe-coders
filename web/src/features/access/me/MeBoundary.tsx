import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/shared/components/ui/Button";
import { useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { MeConsoleContext } from "./me-console-context";
import { useAuth } from "@/app/auth/AuthProvider";
import { LegacyLink } from "@/shared/components/ui/LegacyLink";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
export function MeBoundary({
  children,
  kind = "console",
}: {
  children: ReactNode;
  kind?: "console" | "access";
}) {
  const auth = useAuth();
  const owner = useFeatureReadOwner(
    "me.home",
    kind === "access" ? "me-access-read" : "me-console-read",
    [],
    null,
  );
  const notice = useRef<HTMLDivElement>(null);
  const denied = !owner.readable || owner.denied;
  useEffect(() => {
    if (denied) notice.current?.focus();
  }, [denied]);
  if (denied)
    return (
      <div ref={notice} role="alert" tabIndex={-1} className="page-stack">
        <h1>개인 조회 권한을 확인하세요.</h1>
        <p>
          {kind === "access"
            ? "키 또는 세션 조회 권한이 거부되어 데이터와 작업을 잠갔습니다. 현재 계정의 권한을 확인한 뒤 다시 조회하세요."
            : "로그인한 계정과 내 홈 접근 설정을 확인하세요. 이전 계정의 개인 데이터는 표시하지 않습니다."}
        </p>
        {owner.readable ? <Button onClick={owner.restart}>권한 확인 후 다시 조회</Button> : null}
        {canOpenLegacyAdmin(auth) ? <LegacyLink href="/admin#/me">기존 내 홈 열기</LegacyLink> : null}
      </div>
    );
  return (
    <MeConsoleContext.Provider key={owner.id} value={owner}>
      {children}
    </MeConsoleContext.Provider>
  );
}
