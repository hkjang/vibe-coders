import { useCallback, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { predictScopeMessage } from "./routing-shared";

/** Pure estimator: preserve POST admin:write; readonly itself is not a denial. */
export function useCostPredictionAccess(canPredict: boolean) {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = context?.featureId;
  const known =
    owner === "routing.rules" && context?.permitted === true && typeof context.readOnly === "boolean";
  const routeAllowed = known && auth.user?.scopes.includes("routing:read") === true;
  const allowed = routeAllowed && canPredict === true && auth.user?.scopes.includes("admin:write") === true;
  const reason = !known
    ? "허용된 라우팅 화면인지 확인하세요."
    : !routeAllowed
      ? "라우팅 화면 조회 권한(routing:read)이 없습니다."
      : !allowed
        ? predictScopeMessage
        : undefined;
  const latest = useRef({ owner, known, allowed });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { owner, known, allowed };
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
      latest.current.owner !== owner ||
      !latest.current.known
    )
      throw new AppError("현재 라우팅 화면과 인증 세션을 다시 확인하세요.", { kind: "aborted" });
  }, [epoch, owner]);
  const assertPredict = useCallback(() => {
    assertOwned();
    if (!latest.current.allowed) throw new AppError(predictScopeMessage, { kind: "permission" });
  }, [assertOwned]);
  return {
    allowed,
    reason,
    assertOwned,
    assertPredict,
    credentialPrefixes: auth.credentialPrefixes,
    securityKey: `${epoch}:${owner}:${known}`,
  };
}
export type CostPredictionAccess = ReturnType<typeof useCostPredictionAccess>;
