import { apiClient } from "@/shared/api/client";
import { downloadApiFile } from "@/shared/api/download-file";
import { fileEndpoints } from "@/shared/api/file-endpoints";
import type { PrivacyLedgerDimension } from "@/shared/api/domains/security";
import type { FileDownloadContext } from "@/shared/hooks/use-file-download";

export async function downloadPrivacyLedgerCsv(
  dimension: PrivacyLedgerDimension,
  days: number,
  ownership: FileDownloadContext,
): Promise<void> {
  const file = await apiClient.file(fileEndpoints.privacyLedger, {
    ...ownership,
    query: { dimension, days, format: "csv" },
    routeId: "security.overview",
  });
  downloadApiFile(`privacy-ledger-${dimension}.csv`, file);
}
