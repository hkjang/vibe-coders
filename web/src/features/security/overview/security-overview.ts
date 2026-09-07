import {
  privacyLedgerDimensions,
  secretEventActions,
  securityWindows,
  type PrivacyLedgerDimension,
  type SecurityWindow,
} from "@/shared/api/domains/security";

export const securityTabIds = ["overview", "secrets", "anomalies", "audit", "privacy"] as const;
export type SecurityTabId = (typeof securityTabIds)[number];

export interface SecurityTabDefinition {
  id: SecurityTabId;
  label: string;
  /** Scope the gateway requires for this tab's reads (`adminRequiredScope`). */
  scope: string;
}

export const securityTabs: readonly SecurityTabDefinition[] = [
  { id: "overview", label: "보안 대시보드", scope: "security:read" },
  { id: "secrets", label: "비밀정보 탐지", scope: "security:read" },
  { id: "anomalies", label: "이상 탐지", scope: "costs:read" },
  { id: "audit", label: "인증 이벤트·감사", scope: "admin:read" },
  { id: "privacy", label: "프라이버시 원장", scope: "admin:read" },
];

/**
 * Query keys this screen may keep in the URL. `secret_type` is deliberately
 * shortened to `kind`: the route guard strips any key whose name reads as a
 * credential, and "secret" matches that heuristic.
 */
export const securityOverviewQueryKeys = [
  "action",
  "days",
  "dimension",
  "event",
  "kind",
  "limit",
  "recent",
  "tab",
  "window",
  "z",
] as const;

export const securityWindowLabels: Record<SecurityWindow, string> = {
  "24h": "최근 24시간",
  "7d": "최근 7일",
  "30d": "최근 30일",
};

export function isSecurityWindow(value: string | null): value is SecurityWindow {
  return value !== null && (securityWindows as readonly string[]).includes(value);
}

export const secretActionLabels: Record<string, string> = {
  detect: "탐지",
  mask: "마스킹",
  block: "차단",
};

export function isSecretAction(value: string | null): value is (typeof secretEventActions)[number] {
  return value !== null && (secretEventActions as readonly string[]).includes(value);
}

export const privacyDimensionLabels: Record<PrivacyLedgerDimension, string> = {
  team: "팀",
  model: "모델",
  provider: "공급자",
};

export function isPrivacyDimension(value: string | null): value is PrivacyLedgerDimension {
  return value !== null && (privacyLedgerDimensions as readonly string[]).includes(value);
}

export const anomalyWindows = ["1h", "6h", "24h", "7d"] as const;
export type AnomalyWindow = (typeof anomalyWindows)[number];

export const anomalyWindowLabels: Record<AnomalyWindow, string> = {
  "1h": "최근 1시간",
  "6h": "최근 6시간",
  "24h": "최근 24시간",
  "7d": "최근 7일",
};

export function isAnomalyWindow(value: string | null): value is AnomalyWindow {
  return value !== null && (anomalyWindows as readonly string[]).includes(value);
}

/** z threshold offered by the legacy screen; anything else falls back to 3. */
export const anomalyThresholds = ["2", "2.5", "3", "4"] as const;

export function anomalyThreshold(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 10 ? parsed : 3;
}

export function auditLimit(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 200);
}

export function privacyDays(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 30;
  return Math.min(parsed, 365);
}

export function anomalyDirectionLabel(direction: string): string {
  if (direction === "up") return "상승";
  if (direction === "down") return "하락";
  return direction || "—";
}

export function riskTone(level: string): "danger" | "info" | "muted" | "warning" {
  if (level === "critical") return "danger";
  if (level === "high") return "warning";
  if (level === "medium") return "info";
  return "muted";
}

export function decisionTone(decision: string): "danger" | "info" | "muted" | "warning" {
  if (decision === "block") return "danger";
  if (decision === "warn") return "warning";
  if (decision === "require_approval") return "info";
  return "muted";
}

export function secretActionTone(action: string): "danger" | "info" | "muted" | "warning" {
  if (action === "block") return "danger";
  if (action === "mask") return "warning";
  return "info";
}
