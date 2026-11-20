import { apiClient } from "@/shared/api/client";
import { downloadApiFile } from "@/shared/api/download-file";
import { AppError } from "@/shared/api/error";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { fileEndpoints } from "@/shared/api/file-endpoints";

export const multiRunExportFormats = ["md", "csv", "json"] as const;
export type MultiRunExportFormat = (typeof multiRunExportFormats)[number];

export const multiRunExportFormatLabels: Readonly<Record<MultiRunExportFormat, string>> = {
  md: "마크다운 (.md)",
  csv: "CSV (.csv)",
  json: "JSON (.json)",
};
const exportEndpoints = {
  md: fileEndpoints.multiRunMarkdown,
  csv: fileEndpoints.multiRunCsv,
  json: fileEndpoints.multiRunJson,
} as const;

/** Exact server-rendered bytes; authentication and response deadlines are shared with JSON reads. */
export async function downloadMultiRunExport(
  runId: string,
  format: MultiRunExportFormat,
  options?: { assertCurrent: () => void; signal?: AbortSignal },
): Promise<void> {
  const endpoint = exportEndpoints[format];
  if (!endpoint) throw new AppError("지원하지 않는 실행 내보내기 형식입니다.", { kind: "contract" });
  const file = await apiClient.file(withPathParams(endpoint, { id: runId }), {
    ...options,
    query: { format },
    routeId: "gateway.chat",
  });
  downloadApiFile(`multi-model-${runId}.${format}`, file);
}
