import type { PolicySimulation, PolicySuggestion } from "@/shared/api/domains/governance";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatDateTime, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

export const unknownSimulationValue = "확인할 수 없음";
export const simulationWindows = { "24h": "최근 24시간", "7d": "최근 7일", "30d": "최근 30일" } as const;
export type SimulationWindow = keyof typeof simulationWindows;
export interface SimulationSnapshot {
  readonly id: string;
  readonly title: string;
  readonly window: SimulationWindow;
  readonly conditions: Record<string, unknown>;
  readonly actions: Record<string, unknown>;
}
export function simulationSnapshot(row: PolicySuggestion, window: SimulationWindow): SimulationSnapshot {
  return {
    id: row.id,
    title: row.title ?? row.id,
    window,
    conditions: structuredClone(row.conditions ?? {}),
    actions: structuredClone(row.actions ?? {}),
  };
}
export function simulationCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}
function rate(value: unknown): number | undefined {
  const numeric = nonnegative(value);
  return numeric !== undefined && numeric <= 1 ? numeric : undefined;
}
/** Only aggregate scalars enter local result state; raw sample rows and unknown DTO fields do not. */
export function simulationAggregate(result: PolicySimulation) {
  return {
    evaluated: simulationCount(result.evaluated),
    blocked: simulationCount(result.blocked),
    approved: simulationCount(result.require_approval),
    allowed: simulationCount(result.allowed),
    blockRate: rate(result.block_rate),
    keys: simulationCount(result.shadow?.affected_keys),
    teams: simulationCount(result.shadow?.affected_teams),
    candidates: simulationCount(result.shadow?.false_positive_candidates),
    candidateRate: rate(result.shadow?.false_positive_rate),
    historicalCost: nonnegative(result.shadow?.blocked_cost_krw),
    since:
      typeof result.since === "string" && Number.isFinite(Date.parse(result.since))
        ? new Date(result.since).toISOString()
        : undefined,
  };
}
export type SimulationAggregate = ReturnType<typeof simulationAggregate>;
export function simulationText(value: string | undefined, prefixes: readonly string[]): string {
  return value && containsPotentialSecret(value, prefixes)
    ? "민감정보가 포함될 수 있어 표시하지 않습니다."
    : value || unknownSimulationValue;
}
export const countLabel = (value: number | undefined): string =>
  value === undefined ? unknownSimulationValue : formatNumber(value);
export const rateLabel = (value: number | undefined, denominator: number | undefined): string =>
  value === undefined || denominator === undefined || denominator === 0
    ? unknownSimulationValue
    : formatPercent(value);
export const costLabel = (value: number | undefined): string =>
  value === undefined ? unknownSimulationValue : formatKRW(value);
export const sinceLabel = (value: string | undefined): string =>
  value === undefined ? unknownSimulationValue : formatDateTime(value);

const reconstructedConditions = new Set([
  "model",
  "provider",
  "risk_score",
  "complexity_score",
  "team",
  "team_id",
]);
const incompleteLabels: Readonly<Record<string, string>> = {
  user: "사용자",
  user_id: "사용자 ID",
  role: "역할",
  endpoint: "엔드포인트",
  team_name: "팀 이름",
  contains_secret: "비밀정보 포함",
  secret_type: "비밀정보 유형",
  cost: "비용",
  cost_krw: "원화 비용",
  mcp_server: "MCP 서버",
  mcp_tool: "MCP 도구",
};
export function incompleteConditions(snapshot: SimulationSnapshot, prefixes: readonly string[]): string[] {
  return Object.keys(snapshot.conditions)
    .map((raw) => ({ raw, key: raw.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "").toLowerCase() }))
    .filter(({ key }) => !reconstructedConditions.has(key))
    .map(({ key, raw }) =>
      Object.hasOwn(incompleteLabels, key)
        ? (incompleteLabels[key] ?? key)
        : `알 수 없는 조건 (${simulationText(raw, prefixes)})`,
    );
}
