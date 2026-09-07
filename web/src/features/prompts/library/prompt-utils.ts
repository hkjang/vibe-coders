import { tokenStore } from "@/shared/auth/token-store";

/**
 * Fetches a server-rendered CSV export and offers it as a download. These responses
 * are not JSON, so they bypass `apiClient` and carry the console headers by hand.
 */
export async function downloadServerCsv(path: string, filename: string): Promise<void> {
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

export function assetStatusLabel(status: string | undefined): string {
  switch (status) {
    case "standard":
      return "조직 표준";
    case "approved":
      return "승인됨";
    case "pending":
      return "검토 대기";
    case "draft":
      return "초안";
    default:
      return status ?? "—";
  }
}

export function assetStatusTone(status: string | undefined): "danger" | "info" | "muted" | "success" {
  switch (status) {
    case "standard":
      return "success";
    case "approved":
      return "info";
    case "pending":
      return "muted";
    default:
      return "muted";
  }
}

export function debtTypeLabel(type: string | undefined): string {
  switch (type) {
    case "failing":
      return "실패 다발";
    case "model_waste":
      return "모델 낭비";
    case "expensive":
      return "고비용";
    case "high_volume":
      return "고빈도";
    default:
      return type ?? "—";
  }
}

export function debtTypeTone(type: string | undefined): "danger" | "info" | "muted" | "warning" {
  switch (type) {
    case "failing":
      return "danger";
    case "expensive":
    case "model_waste":
      return "warning";
    case "high_volume":
      return "info";
    default:
      return "muted";
  }
}
