import { useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";

export function useDomainDecisionsAccess() {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const readable =
    (auth.mode === "authenticated" || auth.mode === "legacy" || auth.mode === "open") &&
    context?.featureId === "routing.rules" &&
    context.permitted === true &&
    typeof context.readOnly === "boolean" &&
    auth.user?.scopes.includes("routing:read") === true &&
    auth.capabilities.raw_prompt_view === true;
  const prefixes = auth.credentialPrefixes;
  // Write permission is not a dependency of this read-only explorer.
  const key = JSON.stringify([
    epoch,
    context?.featureId,
    context?.permitted,
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.team_id,
    readable,
    prefixes,
  ]);
  const lifetime = useMemo(() => ({ key }), [key]);
  const latest = useRef({ lifetime, readable });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { lifetime, readable };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const assertRead = () => {
    if (
      !mounted.current ||
      epoch !== tokenStore.getSessionEpoch() ||
      latest.current.lifetime !== lifetime ||
      !latest.current.readable
    )
      throw new AppError("현재 라우팅 화면과 결정 조회 권한을 다시 확인하세요.", { kind: "aborted" });
  };
  return { key, lifetime, readable, prefixes, assertRead };
}
export type DomainDecisionsAccess = ReturnType<typeof useDomainDecisionsAccess>;
