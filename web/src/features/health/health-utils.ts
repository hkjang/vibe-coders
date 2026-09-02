export const healthRanges = ["1h", "24h", "7d", "30d"] as const;
export type HealthRange = (typeof healthRanges)[number];

export function isHealthRange(value: string | null): value is HealthRange {
  return value !== null && healthRanges.some((candidate) => candidate === value);
}

export function refreshIntervalMs(seconds: number): number | false {
  return seconds > 0 ? seconds * 1_000 : false;
}

export function exactTime(timestamp: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(timestamp);
}

export function relativeTime(timestamp: number): string {
  const seconds = Math.round((timestamp - Date.now()) / 1_000);
  const absoluteSeconds = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat("ko-KR", { numeric: "auto" });
  if (absoluteSeconds < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return formatter.format(days, "day");
  return exactTime(timestamp);
}

const numberFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const integerFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const currencyFormatter = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

export function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

export function formatKRW(value: number): string {
  return currencyFormatter.format(value);
}

export function formatMilliseconds(value: number): string {
  return `${numberFormatter.format(value)} ms`;
}

export function formatPercent(value: number): string {
  return `${numberFormatter.format(value * 100)}%`;
}

export function formatBytes(value: number): string {
  if (value < 1_024) return `${integerFormatter.format(value)} B`;
  if (value < 1_048_576) return `${numberFormatter.format(value / 1_024)} KiB`;
  if (value < 1_073_741_824) return `${numberFormatter.format(value / 1_048_576)} MiB`;
  return `${numberFormatter.format(value / 1_073_741_824)} GiB`;
}

export function maxUpdatedAt(...timestamps: number[]): number {
  return Math.max(0, ...timestamps);
}
