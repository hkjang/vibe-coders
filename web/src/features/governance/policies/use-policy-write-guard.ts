import { useRef, useState } from "react";
import { AppError } from "@/shared/api/error";
import type { PolicyEditorAccess } from "./policy-editor-access";

/** Check live authority at dispatch, independently of native button/form state. */
export function usePolicyWriteGuard(access: PolicyEditorAccess) {
  const flights = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const assertWrite = () => {
    access.assertRead();
    access.write.assertCurrent();
  };
  const canOpen = () => {
    try {
      assertWrite();
      return true;
    } catch {
      return false;
    }
  };
  async function run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    assertWrite();
    if (flights.current.has(key)) throw new AppError("같은 작업이 진행 중입니다.", { kind: "aborted" });
    flights.current.add(key);
    setPending((current) => new Set([...current, key]));
    try {
      return await operation();
    } finally {
      flights.current.delete(key);
      setPending((current) => new Set([...current].filter((value) => value !== key)));
    }
  }
  return { canOpen, run, pending };
}
