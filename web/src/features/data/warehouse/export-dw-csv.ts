import type { DwDateBounds } from "@/shared/utils/dw-date-bounds";
import type { DwDimension, DwOrder, DwWindow } from "@/features/data/warehouse/warehouse-filters";
import { apiClient } from "@/shared/api/client";
import { downloadApiFile } from "@/shared/api/download-file";
import { fileEndpoints } from "@/shared/api/file-endpoints";
import type { FileDownloadContext } from "@/shared/hooks/use-file-download";

export async function downloadDwDashboardCsv(
  window: DwWindow,
  dimension: DwDimension,
  order: DwOrder,
  ownership: FileDownloadContext,
  bounds?: DwDateBounds,
): Promise<void> {
  const file = await apiClient.file(fileEndpoints.warehouse, {
    ...ownership,
    query: { window, dimension, order_by: order, limit: 100, ...bounds },
    routeId: "data.warehouse",
  });
  const stamp = new Date().toISOString().slice(0, 10);
  downloadApiFile(`dw-dashboard-${dimension}-${stamp}.csv`, file);
}
