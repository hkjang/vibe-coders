import { useCallback, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";

/** Preview is a read operation even though the existing endpoint uses POST. */
export function useRoutingPreviewAccess() {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = context?.featureId;
  const known =
    owner === "routing.rules" && context?.permitted === true && typeof context.readOnly === "boolean";
  const readAllowed = known && auth.user?.scopes.includes("routing:read") === true;
  const reason = !known
    ? "허용된 라우팅 화면인지 확인하세요."
    : !readAllowed
      ? "미리보기에는 routing:read 조회 권한이 필요합니다."
      : undefined;
  const latest = useRef({ owner, known, readAllowed, prefixes: auth.credentialPrefixes });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { owner, known, readAllowed, prefixes: auth.credentialPrefixes };
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
  const assertRead = useCallback(() => {
    assertOwned();
    if (!latest.current.readAllowed)
      throw new AppError("미리보기에는 routing:read 조회 권한이 필요합니다.", { kind: "permission" });
  }, [assertOwned]);
  const currentPrefixes = useCallback(() => latest.current.prefixes, []);
  return {
    readAllowed,
    reason,
    assertOwned,
    assertRead,
    currentPrefixes,
    credentialPrefixes: auth.credentialPrefixes,
    securityKey: `${epoch}:${owner}:${known}`,
  };
}
export type RoutingPreviewAccess = ReturnType<typeof useRoutingPreviewAccess>;
