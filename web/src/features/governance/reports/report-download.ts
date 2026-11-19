import { apiClient, type ApiFileRequestOptions } from "@/shared/api/client";
import { downloadApiFile } from "@/shared/api/download-file";
import type { RegisteredFileEndpoint } from "@/shared/api/file-endpoints";

/** Registered file contracts share console auth, full-body deadlines and ownership. */
export async function downloadExport<Endpoint extends RegisteredFileEndpoint>(
  endpoint: Endpoint,
  filename: string,
  options: ApiFileRequestOptions<Endpoint>,
): Promise<void> {
  const file = await apiClient.file(endpoint, options);
  downloadApiFile(filename, file);
}

/** Locale-independent UTC date used in export filenames. */
export function exportDateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
