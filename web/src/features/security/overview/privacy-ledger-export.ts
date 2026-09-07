import { AppError } from "@/shared/api/error";
import type { PrivacyLedgerDimension } from "@/shared/api/domains/security";
import { tokenStore } from "@/shared/auth/token-store";
import { downloadText } from "@/shared/utils/csv";

/**
 * The ledger CSV is produced by the gateway (audit deliverable), so it is fetched
 * directly rather than through `apiClient`, which only parses JSON.
 */
export async function downloadPrivacyLedgerCsv(
  dimension: PrivacyLedgerDimension,
  days: number,
): Promise<void> {
  const token = tokenStore.getAccessToken() || tokenStore.getLegacyToken();
  const query = new URLSearchParams({ dimension, days: String(days), format: "csv" });
  const response = await fetch(`/admin/privacy-ledger?${query.toString()}`, {
    headers: {
      Accept: "text/csv",
      "X-Vibe-UI": "app",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new AppError("프라이버시 원장 CSV를 내려받지 못했습니다.", {
      kind: response.status === 403 ? "permission" : "http",
      status: response.status,
      requestId: response.headers.get("X-Request-ID") ?? undefined,
    });
  }
  downloadText(`privacy-ledger-${dimension}.csv`, await response.text(), "text/csv;charset=utf-8");
}
