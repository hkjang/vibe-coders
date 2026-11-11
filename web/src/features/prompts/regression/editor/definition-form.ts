import { z } from "zod";
import type { GoldenPrompt, GoldenStep, GoldenWorkflow } from "@/shared/api/domains/golden";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { hiddenText } from "../regression-model";

export type DefinitionTarget =
  | { kind: "prompt"; id: string; original?: GoldenPrompt }
  | { kind: "workflow"; id: string; original?: GoldenWorkflow };
export function newDefinitionTarget(kind: DefinitionTarget["kind"]): DefinitionTarget {
  // getRandomValues is also available on intranet HTTP; randomUUID is not.
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return kind === "prompt" ? { kind, id: `golden_ui_${suffix}` } : { kind, id: `gwf_ui_${suffix}` };
}
const step = z.object({
  name: z.string().trim(),
  prompt: z.string().trim().min(1, "검사 프롬프트를 입력하세요."),
  expected: z.string(),
  task_type: z.string().optional(),
  selected_model: z.string().optional(),
  baseline_score: z.number().finite().optional(),
  contract_id: z.string().optional(),
  rubric_id: z.string().optional(),
  source_run_id: z.string().optional(),
});
export const definitionSchema = z
  .object({
    kind: z.enum(["prompt", "workflow"]),
    name: z.string().trim().min(1, "이름을 입력하세요."),
    prompt: z.string().trim(),
    expected: z.string(),
    description: z.string(),
    tags: z.string().transform((value, context): string[] => {
      try {
        const parsed = z.array(z.string()).safeParse(JSON.parse(value));
        if (parsed.success) return parsed.data;
      } catch {
        /* Report validation beside the field, never echo input. */
      }
      context.addIssue({ code: "custom", message: '문자열 배열을 입력하세요. 예: ["한글", "회귀"]' });
      return z.NEVER;
    }),
    steps: z.array(step),
  })
  .superRefine((value, context) => {
    if (value.kind === "prompt" && !value.prompt)
      context.addIssue({ code: "custom", path: ["prompt"], message: "기준 프롬프트를 입력하세요." });
    if (value.kind === "workflow" && !value.steps.length)
      context.addIssue({ code: "custom", path: ["steps"], message: "검증 단계를 하나 이상 추가하세요." });
  });
export type DefinitionInput = z.input<typeof definitionSchema>;
export type DefinitionValues = z.output<typeof definitionSchema>;
export const emptyStep = (): GoldenStep => ({ name: "", prompt: "", expected: "" });
export function definitionDefaults(target: DefinitionTarget): DefinitionInput {
  return {
    kind: target.kind,
    name: target.original?.name ?? "",
    tags: JSON.stringify(target.original?.tags ?? []),
    prompt: target.kind === "prompt" ? (target.original?.prompt ?? "") : "",
    expected: target.kind === "prompt" ? (target.original?.expected ?? "") : "",
    description: target.kind === "workflow" ? (target.original?.description ?? "") : "",
    steps: target.kind === "workflow" ? structuredClone(target.original?.steps ?? [emptyStep()]) : [],
  };
}
export function editableDefinition(target: DefinitionTarget, prefixes: readonly string[]) {
  if (!target.original) return true;
  if (target.kind === "workflow" && target.original.steps === null) return false;
  const walk = (value: unknown): boolean => {
    if (typeof value === "string") return value !== hiddenText && !containsPotentialSecret(value, prefixes);
    if (Array.isArray(value)) return value.every(walk);
    if (value && typeof value === "object") return Object.values(value).every(walk);
    return true;
  };
  return walk(target.original);
}

// Explicit allowlists: no models/run, timestamps or arbitrary server properties.
export function promptBody(id: string, values: DefinitionValues) {
  return {
    id,
    name: values.name.trim(),
    prompt: values.prompt.trim(),
    expected: values.expected,
    tags: values.tags,
  };
}
export function workflowBody(id: string, values: DefinitionValues) {
  return {
    id,
    name: values.name.trim(),
    description: values.description,
    tags: values.tags,
    steps: values.steps.map(canonicalStep),
  };
}
function canonicalStep(value: GoldenStep) {
  return {
    name: value.name.trim(),
    prompt: value.prompt.trim(),
    expected: value.expected,
    task_type: value.task_type ?? "",
    selected_model: value.selected_model ?? "",
    baseline_score: value.baseline_score ?? 0,
    contract_id: value.contract_id ?? "",
    rubric_id: value.rubric_id ?? "",
    source_run_id: value.source_run_id ?? "",
  };
}
export function definitionBody(target: DefinitionTarget, values: DefinitionValues) {
  return target.kind === "prompt" ? promptBody(target.id, values) : workflowBody(target.id, values);
}
export function definitionSignature(target: DefinitionTarget, values?: DefinitionValues) {
  if (values) return JSON.stringify(definitionBody(target, values));
  if (!target.original) return undefined;
  const defaults = definitionDefaults(target);
  // Comparing existing definitions must not silently repair empty legacy steps.
  return JSON.stringify(
    target.kind === "prompt"
      ? {
          id: target.id,
          name: defaults.name.trim(),
          prompt: defaults.prompt.trim(),
          expected: defaults.expected,
          tags: target.original.tags ?? [],
        }
      : {
          id: target.id,
          name: defaults.name.trim(),
          description: defaults.description,
          tags: target.original.tags ?? [],
          steps: defaults.steps.map(canonicalStep),
        },
  );
}
