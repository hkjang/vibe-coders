import type { TraceSafeFlow } from "@/shared/api/domains/trace-safe-flow.schema";

export const stepKinds = {
  all: "모든 단계",
  text2sql: "텍스트 SQL 단계",
  tool: "도구",
  mcp_tool: "MCP 도구",
} as const;
export const stepStatuses = {
  all: "모든 상태",
  error: "오류",
  ok: "정상",
  skipped: "건너뜀",
  unknown: "확인 불가",
} as const;
export type StepKind = keyof typeof stepKinds;
export type StepStatus = keyof typeof stepStatuses;

export function isValidTraceStepFilter(key: "flow_kind" | "flow_status", values: readonly string[]): boolean {
  return (
    values.length === 1 && Object.hasOwn(key === "flow_kind" ? stepKinds : stepStatuses, values[0] ?? "")
  );
}

function readOption<T extends string>(
  params: URLSearchParams,
  key: string,
  options: Record<T, string>,
): T | "all" {
  const values = params.getAll(key);
  const value = values[0];
  return values.length === 1 && value && Object.hasOwn(options, value) ? (value as T) : "all";
}

export function readStepFilters(params: URLSearchParams) {
  return {
    kind: readOption(params, "flow_kind", stepKinds),
    status: readOption(params, "flow_status", stepStatuses),
  };
}

export function stepMatches(
  span: TraceSafeFlow["spans"][number],
  kind: StepKind,
  status: StepStatus,
): boolean {
  return (kind === "all" || span.kind === kind) && (status === "all" || span.status === status);
}
