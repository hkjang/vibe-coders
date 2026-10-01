import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";

export function usePolicyEditorAccess(canWrite: boolean) {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = context?.featureId;
  const principal = JSON.stringify([auth.user?.id, auth.user?.role, auth.user?.roles, auth.user?.team_id]);
  const known =
    owner === "governance.policies" && context?.permitted === true && typeof context.readOnly === "boolean";
  const read = known && auth.user?.scopes.includes("security:read") === true;
  const prefixKey = JSON.stringify(auth.credentialPrefixes);
  const write = useFeatureMutationAccess(
    ["governance.policies"],
    canWrite && read && auth.user?.scopes.includes("admin:write") === true,
    "정책 편집에는 security:read와 admin:write 권한이 필요합니다.",
  );
  const approval = useMemo(
    () => ({ read, reason: write.reason, prefixKey }),
    [read, write.reason, prefixKey],
  );
  const latest = useRef({ owner, principal, known, read, prefixKey, approval });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { owner, principal, known, read, prefixKey, approval };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const assertOwned = useCallback(() => {
    if (
      !mounted.current ||
      epoch !== tokenStore.getSessionEpoch() ||
      !latest.current.known ||
      latest.current.owner !== owner ||
      latest.current.principal !== principal
    )
      throw new AppError("현재 정책 화면과 인증 세션을 다시 확인하세요.", { kind: "aborted" });
  }, [epoch, owner, principal]);
  const assertRead = useCallback(() => {
    assertOwned();
    if (!latest.current.read) throw new AppError("정책 조회 권한을 확인하세요.", { kind: "permission" });
  }, [assertOwned]);
  const assertPrefixes = useCallback((expected: string) => {
    if (expected !== latest.current.prefixKey)
      throw new AppError("표시 보호 기준이 바뀌었습니다. 다시 검토하세요.", { kind: "permission" });
  }, []);
  const assertApproval = useCallback((expected: object) => {
    if (expected !== latest.current.approval)
      throw new AppError("실행 권한 또는 표시 보호 기준이 바뀌었습니다. 다시 검토하세요.", {
        kind: "permission",
      });
  }, []);
  return {
    write,
    assertOwned,
    assertRead,
    assertPrefixes,
    assertApproval,
    approval,
    read,
    prefixKey,
    prefixes: auth.credentialPrefixes,
    sessionKey: JSON.stringify([epoch, owner, principal, known]),
  };
}
export type PolicyEditorAccess = ReturnType<typeof usePolicyEditorAccess>;
