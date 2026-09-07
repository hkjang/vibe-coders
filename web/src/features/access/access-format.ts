import { formatPercent } from "@/shared/utils/format";

export type Tone = "danger" | "info" | "muted" | "success" | "warning";

/** A ratio the server sets to -1 to mean "no limit configured" / "no data". */
export function formatSignedRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return "—";
  return formatPercent(value);
}

/** A score the server sets to -1 to mean "not enough data". */
export function formatSignedScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return "—";
  return value.toFixed(1);
}

export function statusTone(status: string): Tone {
  switch (status) {
    case "active":
    case "approved":
      return "success";
    case "disabled":
    case "pending":
      return "warning";
    case "revoked":
    case "rejected":
      return "danger";
    case "external":
      return "info";
    default:
      return "muted";
  }
}

const statusText: Readonly<Record<string, string>> = {
  active: "사용",
  disabled: "중지",
  revoked: "폐기",
  external: "외부 키",
  pending: "승인 대기",
  approved: "승인",
  rejected: "반려",
};

export function statusLabel(status: string): string {
  return statusText[status] ?? (status || "—");
}

export function severityTone(severity: string): Tone {
  switch (severity) {
    case "critical":
    case "high":
    case "error":
      return "danger";
    case "warn":
    case "warning":
    case "medium":
      return "warning";
    case "ok":
    case "pass":
    case "info":
      return "info";
    default:
      return "muted";
  }
}

/** HTTP status tone for the small request tables these screens render. */
export function httpTone(status: number): Tone {
  if (status === 0) return "muted";
  if (status >= 500) return "danger";
  if (status >= 400) return "warning";
  return "success";
}
