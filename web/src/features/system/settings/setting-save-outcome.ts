import { useQueryClient } from "@tanstack/react-query";

import { systemSettingsKeys } from "@/features/system/settings/use-system-settings";
import { isAppError, type AppError } from "@/shared/api/error";

export type SettingReloadPendingNotice = { requestId?: string; observedUpdates: number };

export type SettingSaveResult =
  | { outcome: "saved" }
  | { outcome: "conflict"; error: AppError }
  | ({ outcome: "reload_pending" } & SettingReloadPendingNotice);

/** Both special outcomes require a fresh read, never an automatic write retry. */
async function settingSaveOutcome(
  write: () => Promise<unknown>,
  observedUpdates: () => number,
): Promise<SettingSaveResult> {
  try {
    await write();
    return { outcome: "saved" };
  } catch (error) {
    if (isAppError(error) && error.status === 409) return { outcome: "conflict", error };
    if (isAppError(error) && error.status === 503 && error.code === "setting_reload_pending") {
      // Capture at the write response, before useMutationFeedback invalidates and
      // awaits its reads. Earlier cached/background successes are not evidence,
      // but even a refetch that finishes before onSuccess can prove convergence.
      return { outcome: "reload_pending", requestId: error.requestId, observedUpdates: observedUpdates() };
    }
    throw error;
  }
}

export function useSettingSaveOutcome() {
  const client = useQueryClient();
  return (write: () => Promise<unknown>): Promise<SettingSaveResult> =>
    settingSaveOutcome(write, () => client.getQueryState(systemSettingsKeys.effective)?.dataUpdateCount ?? 0);
}
