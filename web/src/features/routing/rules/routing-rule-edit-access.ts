import { useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";

export function useRoutingEditAccess(canWrite: boolean) {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = context?.featureId;
  const principal = JSON.stringify([
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.team_id,
  ]);
  const readable =
    (auth.mode === "authenticated" || auth.mode === "legacy" || auth.mode === "open") &&
    owner === "routing.rules" &&
    context?.permitted === true &&
    typeof context.readOnly === "boolean" &&
    auth.user?.scopes.includes("routing:read") === true;
  const key = JSON.stringify([epoch, owner, principal, readable]);
  const lifetime = useMemo(() => ({ key }), [key]);
  const prefixes = auth.credentialPrefixes;
  const prefixKey = JSON.stringify(prefixes);
  const write = useFeatureMutationAccess(
    ["routing.rules"],
    canWrite && readable && auth.user?.scopes.includes("routing:write") === true,
    "규칙 수정에는 routing:read와 routing:write 권한이 필요합니다.",
  );
  const approval = useMemo(
    () => ({ lifetime, reason: write.reason, prefixKey }),
    [lifetime, write.reason, prefixKey],
  );
  const latest = useRef({ lifetime, readable, approval });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { lifetime, readable, approval };
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
      throw new AppError("현재 라우팅 화면과 조회 권한을 다시 확인하세요.", { kind: "aborted" });
  };
  const assertApproval = (expected: object) => {
    assertRead();
    write.assertCurrent();
    if (latest.current.approval !== expected)
      throw new AppError("권한 또는 표시 보호 기준이 바뀌었습니다. 다시 검토하세요.", { kind: "permission" });
  };
  return {
    key,
    lifetime,
    epoch,
    owner,
    prefixes,
    prefixKey,
    readable,
    write,
    approval,
    assertRead,
    assertApproval,
  };
}
export type RoutingEditAccess = ReturnType<typeof useRoutingEditAccess>;
