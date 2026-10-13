import { useLayoutEffect, useRef, useState } from "react";
import { AppError, isAppError } from "@/shared/api/error";

/** A denied read locks this owner for the remainder of the mounted screen. */
export function useAdminKeyLifetime(error: unknown, assertWritable: () => void) {
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [locked, setLocked] = useState(false);
  const denied =
    locked ||
    (isAppError(error) &&
      (error.status === 401 || error.status === 403 || error.kind === "auth" || error.kind === "permission"));
  if (denied && !locked) setLocked(true);
  const deniedRef = useRef(denied);
  useLayoutEffect(() => {
    deniedRef.current = denied;
  }, [denied]);
  const ownsResult = () => mounted.current && !deniedRef.current;
  return {
    denied,
    ownsResult,
    assertCurrent: () => {
      assertWritable();
      if (!ownsResult()) throw new AppError("현재 계정의 조회 권한을 다시 확인하세요.", { kind: "aborted" });
    },
  };
}
