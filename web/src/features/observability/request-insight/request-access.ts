import type { AuthContextValue } from "@/app/auth/AuthProvider";

/**
 * Request analysis and replay read captured prompt and response originals, which
 * the gateway gates by role rather than by scope. The bootstrap reports that
 * decision as a capability, so a lower-privilege operator gets a disabled button
 * with the reason instead of discovering a 403 after clicking.
 */
export const rawAccessDeniedReason = "프롬프트 원문 열람 권한이 필요합니다.";

export const noteWriteDeniedReason = "요청 메모 작성에는 admin:write 권한이 필요합니다.";

/** Whether this operator may run the analysis and replay actions. */
export function canInspectRawRequest(auth: AuthContextValue): boolean {
  return auth.capabilities.raw_prompt_view;
}

/** Whether this operator may write the request note. */
export function canWriteRequestNote(auth: AuthContextValue): boolean {
  if (auth.mode !== "authenticated") return true;
  return auth.user?.scopes.includes("admin:write") ?? false;
}
