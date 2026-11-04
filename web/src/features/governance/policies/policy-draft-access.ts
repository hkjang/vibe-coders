import { useCallback, useLayoutEffect, useRef } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppError } from "@/shared/api/error";
import { usePolicyEditorAccess } from "./policy-editor-access";

export function usePolicyDraftAccess(canWrite: boolean) {
  const auth = useAuth();
  const access = usePolicyEditorAccess(canWrite);
  const suggestionsAllowed = access.read && auth.user?.scopes.includes("admin:read") === true;
  const latest = useRef(suggestionsAllowed);
  useLayoutEffect(() => {
    latest.current = suggestionsAllowed;
  }, [suggestionsAllowed]);
  const { assertRead } = access;
  const assertSuggestionsRead = useCallback(() => {
    assertRead();
    if (!latest.current)
      throw new AppError("추천 조회에는 admin:read 권한이 필요합니다.", { kind: "permission" });
  }, [assertRead]);
  return {
    ...access,
    assertSuggestionsRead,
    readAllowed: access.read,
    suggestionsAllowed,
  };
}
export type PolicyDraftAccess = ReturnType<typeof usePolicyDraftAccess>;
