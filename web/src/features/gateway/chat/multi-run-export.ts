import { AppError } from "@/shared/api/error";
import { pathWithParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { tokenStore } from "@/shared/auth/token-store";
import { downloadText } from "@/shared/utils/csv";

export const multiRunExportFormats = ["md", "csv", "json"] as const;
export type MultiRunExportFormat = (typeof multiRunExportFormats)[number];

export const multiRunExportFormatLabels: Readonly<Record<MultiRunExportFormat, string>> = {
  md: "마크다운 (.md)",
  csv: "CSV (.csv)",
  json: "JSON (.json)",
};

const mediaTypes: Readonly<Record<MultiRunExportFormat, string>> = {
  md: "text/markdown;charset=utf-8",
  csv: "text/csv;charset=utf-8",
  json: "application/json;charset=utf-8",
};

/**
 * Downloads the server-rendered export of a multi-model run. The response is a file,
 * not JSON, so it bypasses `apiClient` and carries the console's auth and UI headers
 * by hand. The run id travels in the path only — never a prompt or a response.
 */
export async function downloadMultiRunExport(runId: string, format: MultiRunExportFormat): Promise<void> {
  const path = pathWithParams(endpoints.domains.gateway.chat.multiRunExport.path, { id: runId });
  const token = tokenStore.getAccessToken() || tokenStore.getLegacyToken();
  const response = await fetch(`${path}?format=${format}`, {
    headers: {
      "X-Vibe-UI": "app",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new AppError("실행 결과를 내보내지 못했습니다.", {
      kind: "http",
      status: response.status,
      requestId: response.headers.get("X-Request-ID") ?? undefined,
    });
  }
  downloadText(`multi-model-${runId}.${format}`, await response.text(), mediaTypes[format]);
}
