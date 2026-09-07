import { formatNumber } from "@/shared/utils/format";

/** Windows the governance report screens offer; the server accepts `7d|30d|90d`. */
export const reportWindows = ["7d", "30d", "90d"] as const;
export type ReportWindow = (typeof reportWindows)[number];

export const reportWindowOptions = [
  { value: "7d", label: "최근 7일" },
  { value: "30d", label: "최근 30일" },
  { value: "90d", label: "최근 90일" },
] as const;

export const reportWindowDays: Record<ReportWindow, number> = { "7d": 7, "30d": 30, "90d": 90 };

export function isReportWindow(value: string | null | undefined): value is ReportWindow {
  return reportWindows.includes((value ?? "") as ReportWindow);
}

/** Scorecard dimensions use -1 for "no data"; never render that as a score. */
export function scoreCell(value: number): string {
  return value < 0 ? "—" : formatNumber(Math.round(value));
}

export type ScoreTone = "danger" | "info" | "muted" | "success" | "warning";

export function gradeTone(grade: string): ScoreTone {
  if (grade === "A") return "success";
  if (grade === "B") return "info";
  if (grade === "C") return "warning";
  if (grade === "N/A") return "muted";
  return "danger";
}

export function riskTone(score: number): "danger" | "muted" | "warning" {
  if (score >= 70) return "danger";
  if (score >= 35) return "warning";
  return "muted";
}

export function severityTone(severity: string): "danger" | "info" | "muted" | "warning" {
  if (severity === "high" || severity === "critical") return "danger";
  if (severity === "medium") return "warning";
  if (severity === "low") return "info";
  return "muted";
}
