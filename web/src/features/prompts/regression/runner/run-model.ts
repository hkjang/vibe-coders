import { z } from "zod";
import type { GoldenPrompt, GoldenWorkflow } from "@/shared/api/domains/golden";
import type { GoldenPromptRun, GoldenWorkflowRun } from "@/shared/api/domains/golden-run";
import { AppError } from "@/shared/api/error";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { editableDefinition } from "../editor/definition-form";
import { canLinkRegressionID, safeRegressionText } from "../regression-model";

export const runSchema = z.object({
  ids: z
    .array(z.string())
    .min(1, "실행할 정의를 선택하세요.")
    .max(64, "정의는 최대 64개까지 선택하세요.")
    .refine((ids) => new Set(ids).size === ids.length, "중복된 정의를 선택할 수 없습니다."),
  models: z
    .string()
    .transform((value) => [
      ...new Set(
        value
          .split("\n")
          .map((model) => model.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(
      z
        .array(z.string().max(256, "모델 식별자가 너무 깁니다."))
        .min(1, "모델 식별자를 입력하세요.")
        .max(8, "모델은 최대 8개까지 입력하세요."),
    ),
  passRate: z
    .string()
    .refine(
      (value) =>
        value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100,
      "통과 기준은 0~100 사이로 입력하세요.",
    )
    .transform((value) => Number(value) / 100),
  maxCalls: z
    .string()
    .refine(
      (value) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 64,
      "호출 한도는 1~64 사이의 정수로 입력하세요.",
    )
    .transform(Number),
  outputTokens: z
    .string()
    .refine(
      (value) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 4096,
      "출력 토큰은 1~4096 사이의 정수로 입력하세요.",
    )
    .transform(Number),
});
export type RunInput = z.input<typeof runSchema>;
export type RunValues = z.output<typeof runSchema>;
export type RunCatalog =
  | { kind: "prompt"; rows: GoldenPrompt[]; revisions?: Record<string, string> }
  | { kind: "workflow"; rows: GoldenWorkflow[]; revisions?: Record<string, string> };
export interface RunPlan {
  kind: RunCatalog["kind"];
  values: RunValues;
  definitions: Record<string, string>;
  targets: {
    id: string;
    name: string;
    units: number;
    inputCharacters: number;
    checks: { name: string; prompt: string; expected: string }[];
  }[];
  calls: number;
}
export type RunReceipt = { plan: RunPlan; receivedAt: number } & (
  { kind: "prompt"; result: GoldenPromptRun } | { kind: "workflow"; result: GoldenWorkflowRun }
);

export function runError(code: string) {
  return new AppError("회귀 검사 상태를 확인하세요.", { kind: "permission", code });
}
export function makeRunPlan(catalog: RunCatalog, values: RunValues, prefixes: readonly string[]): RunPlan {
  if (!catalog.revisions) throw runError("golden_run_upgrade");
  if (values.models.some((model) => containsPotentialSecret(model, prefixes)))
    throw runError("golden_run_model");
  if (catalog.kind === "workflow" && values.ids.length !== 1) throw runError("golden_run_selection");
  const revisions: [string, string][] = [];
  const targets = values.ids.map((id) => {
    if (!canLinkRegressionID(id, prefixes)) throw runError("golden_run_selection");
    const revision = catalog.revisions?.[id];
    if (!revision || !/^[a-f0-9]{64}$/.test(revision)) throw runError("golden_run_upgrade");
    revisions.push([id, revision]);
    if (catalog.kind === "prompt") {
      const row = catalog.rows.find((row) => row.id === id);
      if (!row || !editableDefinition({ kind: "prompt", id, original: row }, prefixes))
        throw runError("golden_run_hidden");
      return {
        id,
        name: row.name,
        units: 1,
        inputCharacters: row.prompt.length,
        checks: [{ name: row.name, prompt: row.prompt, expected: row.expected }],
      };
    }
    const row = catalog.rows.find((row) => row.id === id);
    if (!row?.steps?.length || !editableDefinition({ kind: "workflow", id, original: row }, prefixes))
      throw runError("golden_run_hidden");
    return {
      id,
      name: row.name,
      units: row.steps.length,
      inputCharacters: row.steps.reduce((sum, step) => sum + step.prompt.length, 0),
      checks: row.steps.map((step) => ({ name: step.name, prompt: step.prompt, expected: step.expected })),
    };
  });
  const calls = targets.reduce((sum, row) => sum + row.units, 0) * values.models.length;
  if (!calls || calls > values.maxCalls || calls > 64) throw runError("golden_run_limits");
  return {
    kind: catalog.kind,
    values: structuredClone(values),
    definitions: Object.fromEntries(revisions),
    targets,
    calls,
  };
}
export function validateRunReceipt(plan: RunPlan, result: GoldenPromptRun | GoldenWorkflowRun) {
  if (
    result.planned_total !== plan.calls ||
    result.min_pass_rate !== plan.values.passRate ||
    result.max_output_tokens !== plan.values.outputTokens
  )
    throw runError("golden_run_unknown");
  if ("results" in result) {
    if (
      plan.kind !== "prompt" ||
      result.results.some(
        (row) => !plan.values.ids.includes(row.prompt_id) || !plan.values.models.includes(row.model),
      )
    )
      throw runError("golden_run_unknown");
  } else {
    if (
      plan.kind !== "workflow" ||
      result.workflow_id !== plan.values.ids[0] ||
      result.steps.some(
        (row) => !plan.values.models.includes(row.model) || row.step > (plan.targets[0]?.units ?? 0),
      )
    )
      throw runError("golden_run_unknown");
  }
}
export function projectRunReceipt(receipt: RunReceipt, prefixes: readonly string[]): RunReceipt {
  const safe = (value: string) => safeRegressionText(value, prefixes);
  return receipt.kind === "prompt"
    ? {
        ...receipt,
        result: {
          ...receipt.result,
          results: receipt.result.results.map((row) => ({
            ...row,
            response: safe(row.response),
            model: safe(row.model),
          })),
          failures: receipt.result.failures.map((row) => ({
            ...row,
            name: safe(row.name),
            model: safe(row.model),
          })),
        },
      }
    : {
        ...receipt,
        result: {
          ...receipt.result,
          workflow_name: safe(receipt.result.workflow_name),
          steps: receipt.result.steps.map((row) => ({
            ...row,
            name: safe(row.name),
            model: safe(row.model),
          })),
          failures: receipt.result.failures.map((row) => ({
            ...row,
            name: safe(row.name),
            model: safe(row.model),
          })),
        },
      };
}
