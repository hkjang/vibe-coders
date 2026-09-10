import type { BadgeProps } from "@/shared/components/ui/Badge";

/**
 * The ops endpoints answer with their own status vocabularies: cards and workers use
 * ok|warn|critical|unknown|idle, preflight uses ok|warn|fail and incidents use
 * critical|warning|info. One place maps all of them so a new value shows up as
 * "미상" instead of an unlabelled badge.
 */
const statusLabels: Record<string, string> = {
  critical: "위험",
  fail: "실패",
  idle: "유휴",
  info: "정보",
  ok: "정상",
  unknown: "미상",
  warn: "주의",
  warning: "경고",
};

const statusTones: Record<string, BadgeProps["tone"]> = {
  critical: "danger",
  fail: "danger",
  idle: "muted",
  info: "info",
  ok: "success",
  unknown: "muted",
  warn: "warning",
  warning: "warning",
};

export function opsStatusLabel(status: string | null | undefined): string {
  return statusLabels[(status ?? "").toLowerCase()] ?? "미상";
}

export function opsStatusTone(status: string | null | undefined): BadgeProps["tone"] {
  return statusTones[(status ?? "").toLowerCase()] ?? "muted";
}

/** Worst-first ordering, so the row an operator must act on is never below the fold. */
const severityRank: Record<string, number> = { critical: 0, fail: 0, warn: 1, warning: 1, info: 2 };

export function bySeverity(left: string | null | undefined, right: string | null | undefined): number {
  const rank = (value: string | null | undefined): number => severityRank[(value ?? "").toLowerCase()] ?? 3;
  return rank(left) - rank(right);
}

/**
 * A card link is a hash route into the legacy console. The new console owns those
 * screens, so map each one the server can emit and drop anything unmapped rather than
 * sending a reader back to the old console from inside the new one.
 */
const appRouteForLegacyHash: Record<string, string> = {
  "#/billing": "/app/finops",
  "#/dwdashboard/clickhouse": "/app/data/warehouse",
  "#/mcp": "/app/mcp",
  "#/routing/health": "/app/gateway/health",
  "#/skills": "/app/agents/skills",
  "#/text2sql": "/app/text2sql",
};

export function appRouteForCardLink(link: string | null | undefined): string | undefined {
  const value = (link ?? "").trim();
  if (value === "") return undefined;
  const hash = value.startsWith("/admin") ? value.slice("/admin".length) : value;
  return appRouteForLegacyHash[hash];
}
