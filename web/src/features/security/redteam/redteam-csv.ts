import { apiClient } from "@/shared/api/client";
import type { RedTeamImportResult } from "@/shared/api/domains/redteam";
import { downloadApiFile } from "@/shared/api/download-file";
import { endpoints } from "@/shared/api/endpoints";
import { fileEndpoints } from "@/shared/api/file-endpoints";

export interface ProbeCsvContext {
  signal?: AbortSignal;
  assertCurrent?: () => void;
}

/** Preserve the server BOM and exact CSV bytes through the shared authentication engine. */
export async function exportProbePrompts(context: ProbeCsvContext = {}): Promise<void> {
  const file = await apiClient.file(fileEndpoints.probeCsv, {
    ...context,
    query: { format: "csv" },
    routeId: "security.redteam",
  });
  downloadApiFile("redteam-probe-prompts.csv", file);
}

/** Registered raw CSV writes never refresh/replay automatically after authorization failure. */
export function importProbePrompts(csv: string, context: ProbeCsvContext = {}): Promise<RedTeamImportResult> {
  return apiClient.request(endpoints.domains.redteam.probePacks.import, {
    ...context,
    body: csv,
    routeId: "security.redteam",
    retryUnauthorized: false,
  });
}
