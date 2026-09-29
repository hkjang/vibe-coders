import { isAppError, type AppError } from "@/shared/api/error";

export type SettingSaveResult =
  | { outcome: "saved" }
  | { outcome: "conflict"; error: AppError }
  | { outcome: "reload_pending"; requestId?: string };

/** Both special outcomes require a fresh read, never an automatic write retry. */
export async function settingSaveOutcome(write: () => Promise<unknown>): Promise<SettingSaveResult> {
  try {
    await write();
    return { outcome: "saved" };
  } catch (error) {
    if (isAppError(error) && error.status === 409) return { outcome: "conflict", error };
    if (isAppError(error) && error.status === 503 && error.code === "setting_reload_pending") {
      return { outcome: "reload_pending", requestId: error.requestId };
    }
    throw error;
  }
}
