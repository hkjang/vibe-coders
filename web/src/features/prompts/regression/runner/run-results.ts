import type { RunReceipt } from "./run-model";

export interface RunRow {
  id: string;
  target: string;
  model: string;
  passed: boolean;
  error: boolean;
  score: number;
  cost: number;
  latency: number;
  response?: string;
}
export function runRows(receipt: RunReceipt): RunRow[] {
  return receipt.kind === "prompt"
    ? receipt.result.results.map((row) => ({
        id: row.id,
        target: receipt.plan.targets.find((target) => target.id === row.prompt_id)?.name || "이름 없는 검사",
        model: row.model,
        passed: row.passed,
        error: Boolean(receipt.result.execution_errors[row.id]),
        score: row.score,
        cost: row.cost_krw,
        latency: row.latency_ms,
        response: row.response,
      }))
    : receipt.result.steps.map((row) => ({
        id: JSON.stringify([row.model, row.step]),
        target: `${row.step}단계 · ${row.name || "이름 없음"}`,
        model: row.model,
        passed: row.passed,
        error: Boolean(row.error),
        score: row.score,
        cost: row.cost_krw,
        latency: row.latency_ms,
      }));
}
export function compareRunModels(receipt: RunReceipt) {
  const rows = runRows(receipt);
  const models = receipt.plan.values.models.map((model) => {
    const selected = rows.filter((row) => row.model === model);
    return {
      model,
      count: selected.length,
      passed: selected.filter((row) => row.passed).length,
      errors: selected.filter((row) => row.error).length,
      cost: selected.length ? selected.reduce((sum, row) => sum + row.cost, 0) : undefined,
      latency: selected.length
        ? selected.reduce((sum, row) => sum + row.latency, 0) / selected.length
        : undefined,
      passRate: selected.length ? selected.filter((row) => row.passed).length / selected.length : undefined,
    };
  });
  return models.map((model, index) => ({
    ...model,
    baseline: index === 0,
    rateDelta:
      model.passRate === undefined || models[0]?.passRate === undefined
        ? undefined
        : model.passRate - models[0].passRate,
  }));
}
export type RunComparison = ReturnType<typeof compareRunModels>[number];
