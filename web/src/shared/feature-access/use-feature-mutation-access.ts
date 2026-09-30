import { useCallback, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { FeatureAccessContext } from "./context";
import { featureMutationReason } from "./policy";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";

/** Explicitly opt in at persistent writes and real execution, not every POST. */
export function useFeatureMutationAccess(
  owners: readonly string[],
  authorized: boolean,
  permissionReason = "이 작업에 필요한 권한이 없습니다.",
) {
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const reason = featureMutationReason(context, owners) ?? (authorized ? undefined : permissionReason);
  const latest = useRef({ context, reason });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { context, reason };
  }, [context, reason]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owner = context?.featureId;
  const assertCurrent = useCallback((): void => {
    if (
      !mounted.current ||
      epoch !== tokenStore.getSessionEpoch() ||
      latest.current.context?.featureId !== owner
    )
      throw new AppError("현재 화면과 인증 세션을 다시 확인하세요.", { kind: "aborted" });
    if (latest.current.reason) throw new AppError(latest.current.reason, { kind: "permission" });
  }, [epoch, owner]);
  return { allowed: reason === undefined, reason, assertCurrent };
}
