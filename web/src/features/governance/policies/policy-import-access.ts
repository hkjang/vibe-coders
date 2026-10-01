import { useLayoutEffect, useRef } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { usePolicyEditorAccess } from "./policy-editor-access";

export function usePolicyImportAccess(canWrite: boolean) {
  const auth = useAuth();
  const editor = usePolicyEditorAccess(canWrite);
  const mode = auth.mode;
  const knownMode = mode === "authenticated" || mode === "legacy" || mode === "open";
  const latest = useRef(mode);
  useLayoutEffect(() => {
    latest.current = mode;
  }, [mode]);
  const assertRead = () => {
    editor.assertRead();
    if (!knownMode || latest.current !== mode || !auth.user)
      throw new AppError("현재 로그인과 정책 조회 권한을 확인하세요.", { kind: "permission" });
  };
  const assertWrite = () => {
    assertRead();
    editor.write.assertCurrent();
  };
  return {
    ...editor,
    assertRead,
    assertWrite,
    read: editor.read && knownMode && !!auth.user,
    key: JSON.stringify([editor.sessionKey, mode]),
  };
}
export type PolicyImportAccess = ReturnType<typeof usePolicyImportAccess>;
