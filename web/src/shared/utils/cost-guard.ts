import { costGuardSchema, type CostGuard } from "@/shared/api/domains/cost-guard";
import { versionAtLeast } from "@/config/migration-registry";

export const costGuardMinimumVersion = "v0.86.15";
export const costGuardContractMessage =
  "비용 보호 설정을 확인하고 수정하려면 백엔드 v0.86.15 이상이 필요합니다. 서버 버전을 확인하거나 업그레이드하세요. 다른 정책 기능은 계속 사용할 수 있습니다.";

export function supportsCostGuardContract(version: unknown): boolean {
  return typeof version === "string" && versionAtLeast(version, costGuardMinimumVersion);
}

interface GuardState {
  status: "pending" | "error" | "success";
  fetchStatus: "fetching" | "paused" | "idle";
  isInvalidated?: boolean;
  data?: unknown;
}

export function confirmedCostGuard(state: GuardState | undefined): CostGuard | undefined {
  if (!state || state.status !== "success" || state.fetchStatus !== "idle" || state.isInvalidated)
    return undefined;
  const result = costGuardSchema.safeParse(state.data);
  return result.success ? result.data : undefined;
}

/** Settings must show the stored threshold, not money-report rounding to zero. */
export function formatCostGuardThreshold(value: number): string {
  return Number.isFinite(value) && value >= 0 ? `${value}원` : "확인되지 않음";
}
