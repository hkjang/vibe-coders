export const eventWindows = ["1h", "6h", "24h", "7d", "30d"] as const;
export type EventWindow = (typeof eventWindows)[number];

export function isEventWindow(value: string | null | undefined): value is EventWindow {
  return (eventWindows as readonly string[]).includes(value ?? "");
}

export const eventWindowLabels: Record<EventWindow, string> = {
  "1h": "1시간",
  "6h": "6시간",
  "24h": "24시간",
  "7d": "7일",
  "30d": "30일",
};

export function severityTone(severity: string | undefined): "danger" | "info" | "muted" | "warning" {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  if (severity === "info") return "info";
  return "muted";
}

export function severityLabel(severity: string | undefined): string {
  if (severity === "critical") return "심각";
  if (severity === "warning") return "경고";
  if (severity === "info") return "정보";
  return severity ?? "—";
}

export function decisionTone(decision: string | undefined): "danger" | "info" | "muted" | "warning" {
  if (decision === "block" || decision === "secret_block") return "danger";
  if (decision === "require_approval" || decision?.startsWith("deny_")) return "warning";
  if (decision === "mask" || decision === "detect") return "info";
  return "muted";
}

export function approvalTone(status: string | undefined): "danger" | "info" | "muted" | "success" {
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  if (status === "pending") return "info";
  return "muted";
}

export function secretActionTone(action: string | undefined): "danger" | "info" | "muted" | "warning" {
  if (action === "block") return "danger";
  if (action === "mask") return "warning";
  if (action === "detect") return "info";
  return "muted";
}

/** Compact one-line JSON for rule conditions/actions shown inside a table cell. */
export function compactJson(value: unknown): string {
  if (value === null || value === undefined) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}
