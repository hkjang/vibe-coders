import type { workflowStepTypes } from "@/features/agents/workflows/workflow-form";

export type WorkflowStepType = (typeof workflowStepTypes)[number];

/**
 * One step as the editor holds it. Unknown keys are carried through untouched: a
 * workflow may contain fields this build does not render yet, and editing its name
 * must not quietly drop them.
 */
export interface StepDraft extends Record<string, unknown> {
  name?: string;
  type: string;
  ref?: string;
  note?: string;
  timeout_ms?: number;
  max_cost_krw?: number;
  max_tokens?: number;
  allowed_tools?: string[];
  allowed_tables?: string[];
}

/** Which fields each step type actually uses, so the form asks only for those. */
const refLabels: Partial<Record<WorkflowStepType, string>> = {
  chat: "모델",
  mcp_tool: "도구",
  skill: "Skill 이름",
};

const typesWithLimits = new Set<string>(["chat", "mcp_tool", "skill", "text2sql"]);

export function refLabelFor(type: string): string | undefined {
  return refLabels[type as WorkflowStepType];
}

export function hasLimits(type: string): boolean {
  return typesWithLimits.has(type);
}

export function hasAllowedTools(type: string): boolean {
  return type === "mcp_tool";
}

export function hasAllowedTables(type: string): boolean {
  return type === "text2sql";
}

/** Reads the JSON the form holds. An unreadable value yields no steps, never a throw. */
export function parseSteps(json: string): StepDraft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((step): step is Record<string, unknown> => typeof step === "object" && step !== null)
    .map((step) => ({ ...step, type: typeof step.type === "string" ? step.type : "chat" }));
}

export function serializeSteps(steps: readonly StepDraft[]): string {
  return JSON.stringify(steps, null, 2);
}

export function addStep(steps: readonly StepDraft[], type: WorkflowStepType): StepDraft[] {
  return [...steps, { name: "", type }];
}

export function removeStep(steps: readonly StepDraft[], index: number): StepDraft[] {
  return steps.filter((_, position) => position !== index);
}

/** Moves a step one place, clamped: the first step cannot move up out of the list. */
export function moveStep(steps: readonly StepDraft[], index: number, delta: -1 | 1): StepDraft[] {
  const target = index + delta;
  if (index < 0 || index >= steps.length || target < 0 || target >= steps.length) return [...steps];
  const next = [...steps];
  const [moved] = next.splice(index, 1);
  if (moved) next.splice(target, 0, moved);
  return next;
}

/** Drops one key, keeping the rest: an absent limit means "no limit" to the server. */
function withoutField(step: StepDraft, field: string): StepDraft {
  return Object.fromEntries(Object.entries(step).filter(([key]) => key !== field)) as StepDraft;
}

/**
 * Applies one field edit. An emptied field is removed rather than stored as "" or 0,
 * because the server treats an absent limit as "no limit" and a zero as a real zero.
 */
export function updateStep(
  steps: readonly StepDraft[],
  index: number,
  field: string,
  value: string,
): StepDraft[] {
  return steps.map((step, position) => {
    if (position !== index) return step;
    const next: StepDraft = { ...step };
    const trimmed = value.trim();
    if (field === "type") {
      next.type = trimmed;
      // Fields the new type does not use would otherwise travel with the step unseen.
      if (refLabelFor(trimmed) === undefined) delete next.ref;
      if (!hasAllowedTools(trimmed)) delete next.allowed_tools;
      if (!hasAllowedTables(trimmed)) delete next.allowed_tables;
      if (!hasLimits(trimmed)) {
        delete next.timeout_ms;
        delete next.max_tokens;
        delete next.max_cost_krw;
      }
      return next;
    }
    if (field === "allowed_tools" || field === "allowed_tables") {
      const list = trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
      return list.length === 0 ? withoutField(next, field) : { ...next, [field]: list };
    }
    if (field === "timeout_ms" || field === "max_tokens" || field === "max_cost_krw") {
      const parsed = Number(trimmed);
      return trimmed === "" || !Number.isFinite(parsed) || parsed < 0
        ? withoutField(next, field)
        : { ...next, [field]: parsed };
    }
    return trimmed === "" ? withoutField(next, field) : { ...next, [field]: value };
  });
}

/** The value to show in a text field, for a step that may not carry it. */
export function fieldText(step: StepDraft, field: string): string {
  const value = step[field];
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value : "";
}

/** Fields the editor does not render, listed so an operator knows they are preserved. */
const editorFields = new Set([
  "name",
  "type",
  "ref",
  "note",
  "timeout_ms",
  "max_cost_krw",
  "max_tokens",
  "allowed_tools",
  "allowed_tables",
]);

export function unmodelledFields(step: StepDraft): string[] {
  return Object.keys(step)
    .filter((key) => !editorFields.has(key))
    .sort();
}
