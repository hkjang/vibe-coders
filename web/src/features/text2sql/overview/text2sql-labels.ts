import type { BadgeProps } from "@/shared/components/ui/Badge";

/** Column sensitivity values understood by the registry (server: validText2SQLSensitivity). */
export const sensitivityOptions = [
  { value: "normal", label: "일반" },
  { value: "mask", label: "마스킹" },
  { value: "aggregate_only", label: "집계만 허용" },
  { value: "approval_required", label: "승인 필요" },
  { value: "exclude", label: "제외(민감)" },
] as const;

export const sensitivityTones: Record<string, BadgeProps["tone"]> = {
  normal: "muted",
  mask: "warning",
  aggregate_only: "warning",
  approval_required: "danger",
  exclude: "danger",
};

export const statusTones: Record<string, BadgeProps["tone"]> = {
  ok: "success",
  success: "success",
  passed: "success",
  warn: "warning",
  warning: "warning",
  error: "danger",
  failed: "danger",
  rejected: "danger",
  blocked: "danger",
  preview_only: "info",
};

export function sensitivityLabel(value: string): string {
  return sensitivityOptions.find((option) => option.value === value)?.label ?? (value || "일반");
}

/** Reason shown on a disabled control so the operator learns why it is unavailable. */
export function writeDisabledTitle(canWrite: boolean): string | undefined {
  return canWrite ? undefined : "변경하려면 admin:write 권한이 필요합니다.";
}

/** Truncates free text (questions, SQL) for a table cell. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
