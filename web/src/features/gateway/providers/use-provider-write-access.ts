import { useAuth } from "@/app/auth/AuthProvider";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { tokenStore } from "@/shared/auth/token-store";
import { AppError } from "@/shared/api/error";
import { ProviderReadContext } from "./provider-read-owner";

export const providerWriteDeniedReason = "공급자 변경은 admin:write 권한이 필요합니다.";

export function useProviderWriteAccess() {
  const auth = useAuth();
  const owner = useContext(ProviderReadContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const sessionKey = JSON.stringify([epoch, auth.mode, auth.user?.id]);
  const read = auth.user?.scopes.includes("admin:read") === true;
  const identity = JSON.stringify([
    sessionKey,
    auth.user?.team_id,
    auth.user?.role,
    auth.user?.roles,
    read,
    auth.credentialPrefixes,
  ]);
  const lifetime = useMemo(() => ({ identity }), [identity]);
  const current = useRef<typeof lifetime | undefined>(undefined);
  useLayoutEffect(() => {
    current.current = lifetime;
    return () => {
      if (current.current === lifetime) current.current = undefined;
    };
  }, [lifetime]);
  const ownsResult = useCallback(
    () =>
      current.current === lifetime &&
      read &&
      epoch === tokenStore.getSessionEpoch() &&
      (owner?.isCurrent() ?? true),
    [lifetime, read, epoch, owner],
  );
  const access = useFeatureMutationAccess(
    ["gateway.providers"],
    read && (auth.user?.scopes.includes("admin:write") ?? false),
    providerWriteDeniedReason,
  );
  const assertWrite = access.assertCurrent;
  const assertCurrent = useCallback(() => {
    if (!ownsResult()) throw new AppError("공급자 화면과 조회 권한을 다시 확인하세요.", { kind: "aborted" });
    assertWrite();
  }, [assertWrite, ownsResult]);
  return { ...access, assertCurrent, ownsResult, sessionKey };
}
