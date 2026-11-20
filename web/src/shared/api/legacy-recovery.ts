import { legacyRoutes } from "@/config/legacy-route-map";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";

export type LegacyRecoveryDecision = "allowed" | "disabled" | "anonymous" | "forbidden";

export const legacyRecoveryTimeoutMs = 5_000;

export function createLegacyRecoveryRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return "ui-recovery-" + Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Use the existing typed client and retain only the decision, never bootstrap identity data. */
export async function readLegacyRecoveryDecision(
  signal: AbortSignal,
  requestId: string,
): Promise<LegacyRecoveryDecision> {
  const data = await apiClient.request(endpoints.uiBootstrap, {
    signal,
    timeoutMs: legacyRecoveryTimeoutMs,
    retryUnauthorized: false,
    cache: "no-store",
    routeId: "recovery.legacy",
    headers: { "X-Request-ID": requestId },
  });
  if (!data.ui.legacy_fallback) return "disabled";
  if (!data.authentication.authenticated) return "anonymous";
  if (data.authentication.mode === "session" && !data.permissions.includes("admin:read")) {
    return "forbidden";
  }
  return canOpenLegacyAdmin({
    legacyFallback: data.ui.legacy_fallback,
    authenticationMode: data.authentication.mode,
    mode: data.authentication.mode === "legacy_token" ? "legacy" : data.authentication.mode,
    user: data.user ?? undefined,
  })
    ? "allowed"
    : "forbidden";
}

export const legacyRecoveryNavigation = {
  open(): void {
    window.location.assign(legacyRoutes.home);
  },
};
