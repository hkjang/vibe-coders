import { useCallback, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";

/** Pure calculation retains admin:write; feature readonly is deliberately not a denial. */
export function usePolicySimulationAccess(canWrite: boolean) {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = context?.featureId;
  const principal = JSON.stringify([auth.user?.id, auth.user?.role, auth.user?.roles, auth.user?.team_id]);
  const known =
    owner === "governance.policies" && context?.permitted === true && typeof context.readOnly === "boolean";
  const allowed =
    known &&
    canWrite &&
    auth.user?.scopes.includes("security:read") === true &&
    auth.user.scopes.includes("admin:write");
  const latest = useRef({ owner, principal, allowed });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { owner, principal, allowed };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const assertCurrent = useCallback(() => {
    if (
      !mounted.current ||
      epoch !== tokenStore.getSessionEpoch() ||
      owner !== latest.current.owner ||
      principal !== latest.current.principal ||
      !latest.current.allowed
    )
      throw new AppError("현재 정책 화면과 실행 권한을 확인하세요.", { kind: "aborted" });
  }, [epoch, owner, principal]);
  return {
    allowed,
    assertCurrent,
    credentialPrefixes: auth.credentialPrefixes,
    reason: allowed ? undefined : "정책 화면의 조회 권한과 admin:write 실행 권한이 필요합니다.",
    sessionKey: JSON.stringify([epoch, owner, principal, known, allowed]),
  };
}
export type PolicySimulationAccess = ReturnType<typeof usePolicySimulationAccess>;
