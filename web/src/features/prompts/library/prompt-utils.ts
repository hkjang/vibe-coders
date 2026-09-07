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

/** Change-log action names used by `store.PromptTemplateHistory`. */
export function assetHistoryActionLabel(action: string | undefined): string {
  switch (action) {
    case "create":
      return "생성";
    case "edit":
      return "편집";
    case "rollback":
      return "롤백";
    case "submit":
      return "검토 제출";
    case "approve":
      return "승인";
    case "promote":
      return "표준 승격";
    case "reject":
      return "반려";
    default:
      return action ?? "—";
  }
}

export interface AssetStatusTransition {
  /** Target status the `/approve` handler accepts. */
  readonly status: "approved" | "draft" | "standard";
  readonly label: string;
  readonly tone: "danger" | "primary";
}

const approveTransition: AssetStatusTransition = { status: "approved", label: "승인", tone: "primary" };
const promoteTransition: AssetStatusTransition = { status: "standard", label: "표준 승격", tone: "primary" };
const rejectTransition: AssetStatusTransition = { status: "draft", label: "반려", tone: "danger" };

/** Review steps the server allows from the asset's current status (legacy parity). */
export function assetStatusTransitions(status: string | undefined): readonly AssetStatusTransition[] {
  switch (status) {
    case "pending":
      return [approveTransition, rejectTransition];
    case "approved":
      return [promoteTransition, rejectTransition];
    case "standard":
      return [rejectTransition];
    default:
      return [];
  }
}

/** Only a draft can be submitted for review (`draft → pending`). */
export function canSubmitAsset(status: string | undefined): boolean {
  return (status ?? "draft") === "draft";
}

export interface DiffLine {
  readonly key: string;
  readonly text: string;
  readonly tone: "added" | "removed";
}

/**
 * Line-level difference between two version snapshots, matching the legacy
 * screen: a line present in only one side is shown as added or removed.
 */
export function diffPromptBodies(older: string, newer: string): readonly DiffLine[] {
  const oldLines = older.split("\n");
  const newLines = newer.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const lines: DiffLine[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < max; index += 1) {
    const removed = oldLines[index];
    const added = newLines[index];
    if (removed !== undefined && !newSet.has(removed)) {
      lines.push({ key: `-${index}`, text: removed, tone: "removed" });
    }
    if (added !== undefined && !oldSet.has(added)) {
      lines.push({ key: `+${index}`, text: added, tone: "added" });
    }
  }
  return lines;
}
