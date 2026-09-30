import { useCallback, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";

/** Single-call pilot only. Computations retain their existing API permissions. */
export function useChatAccess(canWrite: boolean, canPreview: boolean, writeReason: string) {
  const write = useFeatureMutationAccess(["gateway.chat"], canWrite, writeReason);
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = context?.featureId;
  const known =
    owner === "gateway.chat" && context?.permitted === true && typeof context.readOnly === "boolean";
  const latest = useRef({ owner, known, canWrite, canPreview });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { owner, known, canWrite, canPreview };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Ownership, not current write permission: admitted responses remain readable
  // after a readonly/scope flip, but never after security/session/owner disposal.
  const isCurrent = useCallback(
    () =>
      mounted.current &&
      epoch === tokenStore.getSessionEpoch() &&
      latest.current.owner === owner &&
      latest.current.known,
    [epoch, owner],
  );
  const assertComputation = useCallback(
    (kind: "preview" | "code") => {
      if (!isCurrent())
        throw new AppError("현재 채팅 화면과 인증 세션을 다시 확인하세요.", { kind: "aborted" });
      if (!(kind === "preview" ? latest.current.canPreview : latest.current.canWrite))
        throw new AppError(
          kind === "preview" ? "라우팅 미리보기는 routing:read 권한이 필요합니다." : writeReason,
          { kind: "permission" },
        );
    },
    [isCurrent, writeReason],
  );
  return {
    epoch,
    owner,
    write,
    isCurrent,
    assertComputation,
    previewAllowed: known && canPreview,
    codeAllowed: known && canWrite,
    followupReason: write.allowed
      ? undefined
      : !known
        ? "채팅 화면의 접근 설정을 확인하기 전에는 새 질문을 전송할 수 없습니다. 입력은 유지됩니다."
        : context?.readOnly
          ? "읽기 전용에서는 새 질문을 전송할 수 없습니다. 입력은 유지됩니다."
          : "새 질문 전송에는 admin:write 권한이 필요합니다. 입력은 유지됩니다.",
  };
}
export type ChatAccess = ReturnType<typeof useChatAccess>;
