import { useCallback, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";

export const modelWriteReason = "모델 계약과 지원 종료 정책 변경은 admin:write 권한이 필요합니다.";
export const modelRunReason = "계약 검증은 기존 API의 admin:write 권한이 필요합니다.";

export function useModelAccess() {
  const auth = useAuth();
  const authorized = auth.user?.scopes.includes("admin:write") ?? false;
  const write = useFeatureMutationAccess(["gateway.models"], authorized, modelWriteReason);
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  // contracts/run reads stored observations; readonly must not turn this pure
  // computation into a persistent write, nor grant its existing API permission.
  const runReason =
    context?.featureId !== "gateway.models" ||
    context.permitted !== true ||
    typeof context.readOnly !== "boolean"
      ? "모델 화면의 접근 설정을 확인할 수 없습니다."
      : authorized
        ? undefined
        : modelRunReason;
  const latest = useRef({ owner: context?.featureId, runReason });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { owner: context?.featureId, runReason };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owner = context?.featureId;
  const assertRunCurrent = useCallback(() => {
    if (!mounted.current || epoch !== tokenStore.getSessionEpoch() || owner !== latest.current.owner)
      throw new AppError("현재 모델 화면과 인증 세션을 다시 확인하세요.", { kind: "aborted" });
    if (latest.current.runReason) throw new AppError(latest.current.runReason, { kind: "permission" });
  }, [epoch, owner]);
  return {
    write,
    run: { allowed: runReason === undefined, reason: runReason, assertCurrent: assertRunCurrent },
    epoch,
  };
}
