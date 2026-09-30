import { useCallback, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";

/** Comparison-only ownership; readonly never grants or removes computation scopes. */
export function useCompareAccess(canWrite: boolean, writeDeniedReason: string) {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const write = useFeatureMutationAccess(["gateway.chat"], canWrite, writeDeniedReason);
  const owner = context?.featureId;
  const known =
    owner === "gateway.chat" && context?.permitted === true && typeof context.readOnly === "boolean";
  const readAllowed =
    known && auth.user?.scopes.includes("admin:read") === true && auth.capabilities.raw_prompt_view;
  const readReason = readAllowed
    ? undefined
    : "저장된 실행 조회에는 admin:read와 원문 조회 권한이 필요합니다.";
  const latest = useRef({ owner, known, canWrite, readAllowed });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { owner, known, canWrite, readAllowed };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // An admitted result remains valid after a readonly/scope change. Security
  // disposal is separate from permission to start another execution or write.
  const isCurrent = useCallback(
    () =>
      mounted.current &&
      epoch === tokenStore.getSessionEpoch() &&
      latest.current.owner === owner &&
      latest.current.known,
    [epoch, owner],
  );
  const assertOwned = useCallback(() => {
    if (!isCurrent())
      throw new AppError("현재 비교 화면과 인증 세션을 다시 확인하세요.", { kind: "aborted" });
  }, [isCurrent]);
  const assertRead = useCallback(() => {
    assertOwned();
    if (!latest.current.readAllowed)
      throw new AppError("저장된 실행 조회에는 admin:read와 원문 조회 권한이 필요합니다.", {
        kind: "permission",
      });
  }, [assertOwned]);
  const assertPredict = useCallback(() => {
    assertOwned();
    if (!latest.current.canWrite) throw new AppError(writeDeniedReason, { kind: "permission" });
  }, [assertOwned, writeDeniedReason]);
  return {
    epoch,
    owner,
    known,
    write,
    isCurrent,
    assertRead,
    assertPredict,
    readAllowed,
    readReason,
    predictAllowed: known && canWrite,
  };
}
export type CompareAccess = ReturnType<typeof useCompareAccess>;
