import type { DwDimension, DwOrder, DwWindow } from "@/features/data/warehouse/warehouse-filters";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { downloadText } from "@/shared/utils/csv";

const exportLimit = 100;

/**
 * Downloads the server-rendered dashboard CSV. File responses bypass `apiClient`
 * (which parses JSON), so the auth and UI headers are attached by hand.
 */
export async function downloadDwDashboardCsv(
  window: DwWindow,
  dimension: DwDimension,
  order: DwOrder,
): Promise<void> {
  const query = new URLSearchParams({
    window,
    dimension,
    order_by: order,
    limit: String(exportLimit),
  });
  const token = tokenStore.getAccessToken() || tokenStore.getLegacyToken();
  const response = await fetch(`/admin/dw/dashboard/export.csv?${query.toString()}`, {
    headers: {
      Accept: "text/csv",
      "X-Vibe-UI": "app",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new AppError("CSV를 내보내지 못했습니다.", {
      kind: "http",
      status: response.status,
      requestId: response.headers.get("X-Request-ID") ?? undefined,
    });
  }
  const csv = await response.text();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`dw-dashboard-${dimension}-${stamp}.csv`, csv, "text/csv;charset=utf-8");
}
