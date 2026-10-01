import { useCallback, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";

export function usePolicyDraftAccess(canWrite: boolean) {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = context?.featureId;
  const principal = JSON.stringify([auth.user?.id, auth.user?.role, auth.user?.roles, auth.user?.team_id]);
  const known =
    owner === "governance.policies" && context?.permitted === true && typeof context.readOnly === "boolean";
  const readAllowed = known && auth.user?.scopes.includes("security:read") === true;
  const suggestionsAllowed = readAllowed && auth.user?.scopes.includes("admin:read") === true;
  const write = useFeatureMutationAccess(
    ["governance.policies"],
    canWrite && readAllowed && auth.user?.scopes.includes("admin:write") === true,
    "초안 생성에는 security:read와 admin:write 권한이 필요합니다.",
  );
  const latest = useRef({ known, owner, principal, readAllowed, suggestionsAllowed });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { known, owner, principal, readAllowed, suggestionsAllowed };
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
    if (!latest.current.readAllowed)
      throw new AppError("정책 조회 권한을 확인하세요.", { kind: "permission" });
  }, [assertOwned]);
  const assertSuggestionsRead = useCallback(() => {
    assertRead();
    if (!latest.current.suggestionsAllowed)
      throw new AppError("추천 조회에는 admin:read 권한이 필요합니다.", { kind: "permission" });
  }, [assertRead]);
  return {
    write,
    assertOwned,
    assertRead,
    assertSuggestionsRead,
    readAllowed,
    suggestionsAllowed,
    prefixes: auth.credentialPrefixes,
    sessionKey: JSON.stringify([epoch, owner, principal, known]),
  };
}
export type PolicyDraftAccess = ReturnType<typeof usePolicyDraftAccess>;
