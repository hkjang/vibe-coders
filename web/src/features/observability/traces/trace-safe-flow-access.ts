import { useCallback, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";

export function useTraceSafeFlowAccess() {
  const auth = useAuth();
  const feature = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = feature?.featureId;
  const principal = JSON.stringify([
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.team_id,
  ]);
  const readable =
    (auth.mode === "authenticated" || auth.mode === "legacy" || auth.mode === "open") &&
    owner === "observability.traces" &&
    feature?.permitted === true &&
    typeof feature.readOnly === "boolean" &&
    auth.user?.scopes.includes("admin:read") === true;
  const latest = useRef({ principal, owner, readable });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { principal, owner, readable };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const assertRead = useCallback(() => {
    if (
      !mounted.current ||
      epoch !== tokenStore.getSessionEpoch() ||
      !latest.current.readable ||
      latest.current.owner !== owner ||
      latest.current.principal !== principal
    )
      throw new AppError("현재 요청 조회 권한을 확인하세요.", { kind: "aborted" });
  }, [epoch, owner, principal]);
  return {
    readable,
    assertRead,
    prefixes: auth.credentialPrefixes,
    key: JSON.stringify([epoch, owner, principal, readable]),
  };
}
export type TraceSafeFlowAccess = ReturnType<typeof useTraceSafeFlowAccess>;
