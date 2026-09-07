import type { BadgeProps } from "@/shared/components/ui/Badge";

type Tone = NonNullable<BadgeProps["tone"]>;

const riskTones: Record<string, Tone> = {
  low: "success",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

export function riskTone(level: string): Tone {
  return riskTones[level.toLowerCase()] ?? "muted";
}

const decisionTones: Record<string, Tone> = {
  allow: "success",
  warn: "warning",
  approval_required: "warning",
  block: "danger",
  not_in_allowlist: "warning",
  require_approval: "warning",
};

export function decisionTone(decision: string): Tone {
  return decisionTones[decision.toLowerCase()] ?? "muted";
}

const statusTones: Record<string, Tone> = {
  ok: "success",
  warn: "warning",
  error: "danger",
  blocked: "danger",
};

export function stepTone(status: string): Tone {
  return statusTones[status.toLowerCase()] ?? "info";
}

export const decisionLabels: Record<string, string> = {
  allow: "허용",
  warn: "경고",
  block: "차단",
  approval_required: "승인 필요",
  require_approval: "승인 필요",
  not_in_allowlist: "허용목록 외",
};

export function decisionLabel(decision: string): string {
  return decisionLabels[decision.toLowerCase()] ?? (decision || "—");
}

/** "a, b" → ["a","b"]; blank entries are dropped so an empty field sends nothing. */
export function csvToList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function listToCsv(value: readonly string[] | undefined): string {
  return (value ?? []).join(", ");
}

/** Renders an unknown JSON scalar as short display text. */
export function detailText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value === "" ? "—" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
