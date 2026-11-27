import { isAppError } from "@/shared/api/error";

/**
 * True when the server says the analysis itself is not there (not built into this
 * server yet, or switched off), as opposed to one request failing.
 */
export function isUnavailable(error: unknown): boolean {
  if (!isAppError(error)) return false;
  if (error.status === 501 || error.status === 404) return true;
  return /not_implemented|analytics_disabled|work_intel_disabled/u.test(error.code ?? "");
}

export function isAnalyticsDisabled(error: unknown): boolean {
  return isAppError(error) && /analytics_disabled|work_intel_disabled/u.test(error.code ?? "");
}
