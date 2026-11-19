import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { fileEndpoints } from "@/shared/api/file-endpoints";

/** Read-only CSV with shared authentication, no network retry or external redirects. */
export async function readChargebackCsv(month: string, signal: AbortSignal): Promise<string> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month))
    throw new AppError("정산 월 형식을 확인하세요.", { kind: "contract" });
  const file = await apiClient.file(fileEndpoints.chargeback, {
    query: { format: "csv", month },
    signal,
    routeId: "finops.overview",
  });
  const csv = new TextDecoder().decode(file.bytes);
  file.assertCurrent();
  return csv;
}
