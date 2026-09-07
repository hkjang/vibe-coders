const locale = "ko-KR";
const timeZone = "Asia/Seoul";

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}

export function formatKRW(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `₩${new Intl.NumberFormat(locale, { maximumFractionDigits: value < 100 ? 2 : 0 }).format(value)}`;
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return `${minutes}분 ${seconds}초`;
}

function parseDate(value: string | number | Date | null | undefined): Date | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `2026-09-07 14:03:15` in Asia/Seoul; empty and invalid values render as a dash. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = parseDate(value);
  if (!date) return "—";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return parts.replace("T", " ");
}

export function formatDate(value: string | number | Date | null | undefined): string {
  const date = parseDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** "3분 전" style relative time for lists; falls back to the absolute time past a day. */
export function formatRelative(value: string | number | Date | null | undefined, now = Date.now()): string {
  const date = parseDate(value);
  if (!date) return "—";
  const diff = now - date.getTime();
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "전" : "후";
  if (abs < 45_000) return "방금";
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}분 ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}시간 ${suffix}`;
  return formatDateTime(date);
}

/** Truncates identifiers for tables while keeping the full value in `title`. */
export function shortId(value: string | null | undefined, keep = 12): string {
  if (!value) return "—";
  return value.length <= keep ? value : `${value.slice(0, keep)}…`;
}
