import { AppError } from "@/shared/api/error";

// Fixed, non-sensitive origin-wide name: session epochs differ between tabs.
// Deliberately serializes all console MCP calls, even across account changes.
const lockName = "vibe:app:mcp-test-call";
export const supportsMcpCallLock = () =>
  typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";

export async function withMcpCallLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!supportsMcpCallLock())
    throw new AppError("MCP 호출 잠금을 지원하지 않습니다.", {
      kind: "aborted",
      code: "mcp_call_lock_unavailable",
    });
  // Never queue a destructive/billable call for later, implicit execution.
  return navigator.locks.request(lockName, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock)
      throw new AppError("다른 탭의 MCP 호출이 진행 중입니다.", {
        kind: "aborted",
        code: "mcp_call_in_progress",
      });
    return operation();
  });
}
