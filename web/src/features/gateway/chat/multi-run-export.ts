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
export async function downloadMultiRunExport(
  runId: string,
  format: MultiRunExportFormat,
  options?: { assertCurrent: () => void; signal?: AbortSignal },
): Promise<void> {
  const epoch = tokenStore.getSessionEpoch();
  const assertCurrent = () => {
    if (epoch !== tokenStore.getSessionEpoch() || options?.signal?.aborted)
      throw new AppError("이전 인증 세션의 결과는 내려받을 수 없습니다.", { kind: "aborted" });
    options?.assertCurrent();
  };
  assertCurrent();
  const path = pathWithParams(endpoints.domains.gateway.chat.multiRunExport.path, { id: runId });
  const token = tokenStore.getAccessToken() || tokenStore.getLegacyToken();
  const response = await fetch(`${path}?format=${format}`, {
    ...(options?.signal ? { signal: options.signal } : {}),
    headers: {
      "X-Vibe-UI": "app",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  assertCurrent();
  if (!response.ok) {
    throw new AppError("실행 결과를 내보내지 못했습니다.", {
      kind: "http",
      status: response.status,
      requestId: response.headers.get("X-Request-ID") ?? undefined,
    });
  }
  const text = await response.text();
  assertCurrent();
  downloadText(`multi-model-${runId}.${format}`, text, mediaTypes[format]);
}
