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

/** Every page and apply sends the original file; never retry or fall back to legacy import. */
export function reviewProbePrompts(
  csv: string,
  offset = 0,
  revision?: string,
  context: ProbeCsvContext = {},
) {
  return apiClient.request(endpoints.domains.redteam.probePacks.reviewed.review, {
    ...context,
    body: csv,
    query: { offset, limit: 20 },
    ...(revision ? { headers: { "If-Match": '"' + revision + '"' } } : {}),
    routeId: "security.redteam",
    retryUnauthorized: false,
  });
}
export function applyReviewedProbePrompts(csv: string, revision: string, context: ProbeCsvContext = {}) {
  return apiClient.request(endpoints.domains.redteam.probePacks.reviewed.apply, {
    ...context,
    body: csv,
    headers: { "If-Match": '"' + revision + '"' },
    routeId: "security.redteam",
    retryUnauthorized: false,
  });
}
