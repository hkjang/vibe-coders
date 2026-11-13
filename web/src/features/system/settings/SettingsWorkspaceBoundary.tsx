import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { tokenStore } from "@/shared/auth/token-store";
import { Button } from "@/shared/components/ui/Button";
import { featureOwnedKey, useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { SettingsWorkspaceContext } from "./settings-workspace-context";
import { systemSettingsKeys } from "./use-system-settings";

export function SettingsWorkspaceBoundary({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const client = useQueryClient();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = useFeatureReadOwner("system.settings", "settings-workspace-read");
  const principal = JSON.stringify([
    epoch,
    auth.mode,
    auth.user?.id,
    auth.user?.team_id,
    auth.user?.role,
    auth.user?.roles,
  ]);
  const scopedWriter = ["ops_admin", "ai_admin", "security_admin"].includes(auth.user?.role ?? "");
  const value = useMemo(
    () => ({
      owner,
      principal,
      scopedWriter,
      effectiveKey: featureOwnedKey(systemSettingsKeys.effective, owner),
    }),
    [owner, principal, scopedWriter],
  );
  const denied = !owner.readable || owner.denied;
  useLayoutEffect(() => {
    // Keep only this principal's outcome metadata across route unmounts. A new
    // principal or denied read must never retain another account's request ID.
    client.removeQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === "system" &&
        queryKey[1] === "settings" &&
        queryKey[2] === "reload-pending-notice" &&
        (denied || queryKey[3] !== principal),
    });
  }, [client, denied, principal]);
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (denied) notice.current?.focus();
  }, [denied]);
  if (denied)
    return (
      <div ref={notice} role="alert" tabIndex={-1} className="page-stack">
        <h2>설정 조회 권한 확인 필요</h2>
        <p>현재 계정의 조회 권한을 확인할 수 없어 이전 설정·변경 이력과 초안을 표시하지 않습니다.</p>
        <p>관리자에게 admin:read 권한과 시스템 설정 접근 조건을 확인해 달라고 요청하세요.</p>
        {owner.readable ? <Button onClick={owner.restart}>권한 확인 후 다시 조회</Button> : null}
      </div>
    );
  return (
    <SettingsWorkspaceContext.Provider key={owner.id} value={value}>
      {children}
    </SettingsWorkspaceContext.Provider>
  );
}
