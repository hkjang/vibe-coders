import { useCallback, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";

export type TraceSafeFlowOwner = "observability.traces" | "observability.requests";

export function useTraceSafeFlowAccess(expectedOwner: TraceSafeFlowOwner = "observability.traces") {
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
    owner === expectedOwner &&
    feature?.permitted === true &&
    typeof feature.readOnly === "boolean" &&
    auth.user?.scopes.includes("admin:read") === true;
  const latest = useRef({ principal, owner, readable, expectedOwner });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { principal, owner, readable, expectedOwner };
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
      latest.current.expectedOwner !== expectedOwner ||
      latest.current.principal !== principal
    )
      throw new AppError("현재 요청 조회 권한을 확인하세요.", { kind: "aborted" });
  }, [epoch, owner, principal, expectedOwner]);
  return {
    readable,
    assertRead,
    prefixes: auth.credentialPrefixes,
    routeId: expectedOwner,
    key: JSON.stringify([epoch, expectedOwner, owner, principal, readable]),
  };
}
export type TraceSafeFlowAccess = ReturnType<typeof useTraceSafeFlowAccess>;
