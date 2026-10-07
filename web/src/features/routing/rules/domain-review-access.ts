import { useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { domainReviewChanged } from "./domain-review-state";

export function useDomainReviewAccess(canWrite: boolean) {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = context?.featureId;
  const raw = auth.capabilities.raw_prompt_view === true;
  const readScope = auth.user?.scopes.includes("routing:read") === true;
  const writeScope = auth.user?.scopes.includes("routing:write") === true;
  const readable =
    (auth.mode === "authenticated" || auth.mode === "legacy" || auth.mode === "open") &&
    owner === "routing.rules" &&
    context?.permitted === true &&
    typeof context.readOnly === "boolean" &&
    readScope &&
    raw;
  const prefixes = auth.credentialPrefixes;
  const key = JSON.stringify([
    epoch,
    owner,
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.team_id,
    context?.permitted,
    context?.readOnly,
    readScope,
    writeScope,
    canWrite,
    raw,
    prefixes,
  ]);
  const lifetime = useMemo(() => ({ key }), [key]);
  const write = useFeatureMutationAccess(
    ["routing.rules"],
    canWrite && readable && writeScope,
    "검토 상태 기록에는 routing:read, routing:write 및 프롬프트 원문 조회 권한이 필요합니다.",
  );
  const approval = useMemo(() => ({ lifetime, reason: write.reason }), [lifetime, write.reason]);
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
      throw new AppError("현재 라우팅 화면과 검토 조회 권한을 다시 확인하세요.", { kind: "aborted" });
  };
  const assertApproval = (expected: object) => {
    assertRead();
    write.assertCurrent();
    if (latest.current.approval !== expected) throw new AppError(domainReviewChanged, { kind: "permission" });
  };
  return { key, lifetime, readable, prefixes, write, approval, assertRead, assertApproval };
}
export type DomainReviewAccess = ReturnType<typeof useDomainReviewAccess>;
