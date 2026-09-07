import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { downloadText } from "@/shared/utils/csv";

export const finopsBillingQueryKey = ["finops", "billing"] as const;
export const finopsAllocationQueryKey = ["finops", "allocation"] as const;
export const finopsChargebackQueryKey = ["finops", "chargeback"] as const;
export const finopsAnomaliesQueryKey = ["finops", "anomalies"] as const;
export const finopsBudgetAlertsQueryKey = ["finops", "budget-alerts"] as const;

export const costWindows = ["24h", "7d", "30d"] as const;
export const defaultCostWindow = "30d";

/** Dimensions `store.CostAllocationDimensions()` accepts. */
export const allocationDimensions = [
  "project",
  "repo",
  "branch",
  "service",
  "cost_center",
  "model",
  "provider",
  "api_key_id",
] as const;
export const defaultAllocationDimension = "project";

export const dimensionLabels: Record<string, string> = {
  project: "프로젝트",
  repo: "저장소",
  branch: "브랜치",
  service: "서비스",
  cost_center: "비용센터",
  model: "모델",
  provider: "공급자",
  api_key_id: "API 키",
  team: "팀",
};

export const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/u;

export function costWindowFrom(value: string | null): string {
  return (costWindows as readonly string[]).includes(value ?? "") ? (value as string) : defaultCostWindow;
}

export function allocationDimensionFrom(value: string | null): string {
  return (allocationDimensions as readonly string[]).includes(value ?? "")
    ? (value as string)
    : defaultAllocationDimension;
}

export function currentMonth(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
  }).format(now);
}

export function severityTone(severity: string): "danger" | "warning" | "info" {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  return "info";
}

/**
 * Downloads the server-rendered chargeback CSV. File responses bypass `apiClient`
 * (which parses JSON), so the auth and UI headers are attached by hand.
 */
export async function downloadChargebackCsv(month: string): Promise<void> {
  const query = new URLSearchParams({ format: "csv" });
  if (monthPattern.test(month)) query.set("month", month);
  const token = tokenStore.getAccessToken() || tokenStore.getLegacyToken();
  const response = await fetch(`/admin/cost/chargeback-pack?${query.toString()}`, {
    headers: {
      Accept: "text/csv",
      "X-Vibe-UI": "app",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new AppError("비용 배부 CSV를 내려받지 못했습니다.", {
      kind: "http",
      status: response.status,
      requestId: response.headers.get("X-Request-ID") ?? undefined,
    });
  }
  const csv = await response.text();
  downloadText(`chargeback-${month || currentMonth()}.csv`, csv, "text/csv;charset=utf-8");
}
