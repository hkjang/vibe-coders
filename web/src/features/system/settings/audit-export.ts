import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";

export const auditCsvLimit = 5000;

export function readAuditCsv(signal: AbortSignal): Promise<string> {
  return apiClient.request(endpoints.domains.system.audit.csv, {
    signal,
    routeId: "system.settings",
    query: { limit: auditCsvLimit },
    headers: { Accept: "text/csv" },
    cache: "no-store",
  });
}
