import type { GoldenPrompt, GoldenResult, GoldenWorkflow } from "@/shared/api/domains/golden";
import { containsPotentialSecret } from "@/shared/security/secrets";

export const regressionId = "prompts.regression";
export const regressionTabs = ["prompts", "workflows", "results"] as const;
export type RegressionTab = (typeof regressionTabs)[number];
export const regressionTabItems = [
  { id: "prompts" as const, label: "기준 프롬프트" },
  { id: "workflows" as const, label: "검증 워크플로" },
  { id: "results" as const, label: "최근 실행 결과" },
];
export const hiddenText = "민감한 값 또는 표시 한도를 넘는 내용은 숨겼습니다.";
export const safeRegressionText = (value: string, prefixes: readonly string[]) =>
  containsPotentialSecret(value, prefixes) ? hiddenText : value;
export const canLinkRegressionID = (id: string, prefixes: readonly string[]) =>
  id.length > 0 &&
  id.length <= 512 &&
  id.trim() === id &&
  ![...id].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
  !containsPotentialSecret(id, prefixes);

/** Project stored text before it enters the screen's Query cache. IDs retain identity
 * internally, but are separately checked before display or URL navigation. */
export function projectPrompts(
  data: { golden_prompts: GoldenPrompt[]; results: GoldenResult[]; run_revisions?: Record<string, string> },
  prefixes: readonly string[],
) {
  const safe = (value: string) => safeRegressionText(value, prefixes);
  return {
    ...(data.run_revisions ? { run_revisions: data.run_revisions } : {}),
    golden_prompts: data.golden_prompts.map((row) => ({
      ...row,
      name: safe(row.name),
      prompt: safe(row.prompt),
      expected: safe(row.expected),
      tags: row.tags?.map(safe) ?? null,
    })),
    results: data.results.map((row) => ({ ...row, model: safe(row.model), response: safe(row.response) })),
  };
}
export function projectWorkflows(
  data: { workflows: GoldenWorkflow[]; run_revisions?: Record<string, string> },
  prefixes: readonly string[],
) {
  const safe = (value: string) => safeRegressionText(value, prefixes);
  return {
    ...(data.run_revisions ? { run_revisions: data.run_revisions } : {}),
    workflows: data.workflows.map((row) => ({
      ...row,
      name: safe(row.name),
      description: safe(row.description),
      tags: row.tags?.map(safe) ?? null,
      steps:
        row.steps?.map((step) => ({
          ...step,
          name: safe(step.name),
          prompt: safe(step.prompt),
          expected: safe(step.expected),
          task_type: step.task_type === undefined ? undefined : safe(step.task_type),
          selected_model: step.selected_model === undefined ? undefined : safe(step.selected_model),
          contract_id: step.contract_id === undefined ? undefined : safe(step.contract_id),
          rubric_id: step.rubric_id === undefined ? undefined : safe(step.rubric_id),
          source_run_id: step.source_run_id === undefined ? undefined : safe(step.source_run_id),
        })) ?? null,
    })),
  };
}
export function resultSummary(rows: readonly GoldenResult[]) {
  return {
    count: rows.length,
    passRate: rows.length ? rows.filter((row) => row.passed).length / rows.length : undefined,
    cost: rows.length ? rows.reduce((sum, row) => sum + row.cost_krw, 0) : undefined,
    latency: rows.length ? rows.reduce((sum, row) => sum + row.latency_ms, 0) / rows.length : undefined,
  };
}
