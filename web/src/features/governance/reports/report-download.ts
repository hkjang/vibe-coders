import { tokenStore } from "@/shared/auth/token-store";

/**
 * Fetches a server-rendered export (CSV / Markdown / JSON) and offers it as a download.
 * These responses are not JSON, so they bypass `apiClient` and carry the console's auth
 * and UI headers by hand.
 */
export async function downloadExport(path: string, filename: string): Promise<void> {
  const token = tokenStore.getAccessToken() || tokenStore.getLegacyToken();
  const headers = new Headers({ "X-Vibe-UI": "app" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { headers });
  if (!response.ok) throw new Error(`내보내기에 실패했습니다. (HTTP ${response.status})`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** `2026-09-07` in the operator's locale-independent form, used in export file names. */
export function exportDateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
