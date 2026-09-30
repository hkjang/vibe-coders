import { useCallback, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";

export function useModelTagAccess(canWrite: boolean, denied: string) {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = context?.featureId;
  const known =
    owner === "gateway.chat" && context?.permitted === true && typeof context.readOnly === "boolean";
  const readAllowed = known && auth.user?.scopes.includes("admin:read") === true;
  const write = useFeatureMutationAccess(
    ["gateway.chat"],
    canWrite && auth.user?.scopes.includes("admin:write") === true && readAllowed,
    denied,
  );
  const latest = useRef({ owner, known, readAllowed });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = { owner, known, readAllowed };
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
      throw new AppError("현재 태그 화면과 인증 세션을 다시 확인하세요.", { kind: "aborted" });
  }, [epoch, owner]);
  const assertRead = useCallback(() => {
    assertOwned();
    if (!latest.current.readAllowed)
      throw new AppError("태그 조회에는 admin:read 권한이 필요합니다.", { kind: "permission" });
  }, [assertOwned]);
  return { epoch, owner, known, readAllowed, assertRead, assertOwned, write };
}
export type ModelTagAccess = ReturnType<typeof useModelTagAccess>;

/** Component-local lifetime and synchronous flight lock, in addition to route/session ownership. */
export function useModelTagOperation(access: ModelTagAccess) {
  const mounted = useRef(false);
  const flight = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current?.abort();
      flight.current = null;
    };
  }, []);
  async function run<T>(
    work: (assertAdmission: () => void, signal: AbortSignal) => Promise<T>,
    committed?: (result: T) => void,
  ): Promise<T> {
    if (!mounted.current || flight.current)
      throw new AppError("이전 태그 작업을 기다려 주세요.", { kind: "aborted" });
    access.write.assertCurrent();
    access.assertRead();
    const current = new AbortController();
    flight.current = current;
    setPending(true);
    const assertOwned = () => {
      access.assertOwned();
      if (!mounted.current || flight.current !== current || current.signal.aborted)
        throw new AppError("종료된 태그 작업입니다.", { kind: "aborted" });
    };
    const assertAdmission = () => {
      assertOwned();
      access.write.assertCurrent();
      access.assertRead();
    };
    try {
      const result = await work(assertAdmission, current.signal);
      assertOwned();
      committed?.(result);
      return result;
    } catch (error) {
      assertOwned();
      throw error;
    } finally {
      if (flight.current === current) {
        flight.current = null;
        if (mounted.current) setPending(false);
      }
    }
  }
  return { pending, run };
}
