import {
  promptExperimentSchema,
  promptContractSchema,
  promptRubricSchema,
  promptTestCaseSchema,
  type PromptTestCaseRun,
} from "@/shared/api/domains/gateway.schemas";
import { AppError, isAppError } from "@/shared/api/error";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import type { z } from "zod";

export const hiddenLabText = "민감한 내용은 숨겼습니다.";
export const labIDAllowed = (id: string, prefixes: readonly string[]) =>
  id.length > 0 &&
  id.length <= 512 &&
  id.trim() === id &&
  ![...id].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
  !containsPotentialSecret(id, prefixes);
export function labError(message: string, code = "prompt_lab_changed") {
  return new AppError(message, { kind: "contract", code });
}
export function assertLabStatus(value: unknown, status: string) {
  if (!value || typeof value !== "object" || !("status" in value) || value.status !== status)
    throw labError("변경 처리 결과를 확인할 수 없습니다.", "prompt_lab_unknown");
}
export function safeLabError(error: unknown, prefixes: readonly string[]) {
  if (isAppError(error))
    return new AppError(safeAppErrorMessage(error, "실험실 작업을 완료하지 못했습니다."), {
      kind: error.kind,
      status: error.status,
      code: error.code?.startsWith("prompt_lab_") ? error.code : undefined,
      requestId:
        error.requestId && !containsPotentialSecret(error.requestId, prefixes) ? error.requestId : undefined,
    });
  return new AppError("실험실 작업을 완료하지 못했습니다.", { kind: "network" });
}
function safeFields<T extends object>(row: T, prefixes: readonly string[]): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "string" && containsPotentialSecret(value, prefixes) ? hiddenLabText : value,
    ]),
  ) as T;
}
function project<Schema extends z.ZodType<{ id: string }>>(
  schema: Schema,
  value: unknown,
  prefixes: readonly string[],
): z.output<Schema> {
  const row = schema.parse(value);
  if (!labIDAllowed(row.id, prefixes)) throw labError("응답의 식별자를 안전하게 확인할 수 없습니다.");
  return safeFields(row, prefixes) as z.output<Schema>;
}
export const projectExperiment = (value: unknown, prefixes: readonly string[]) =>
  project(promptExperimentSchema.strip(), value, prefixes);
export const projectContract = (value: unknown, prefixes: readonly string[]) =>
  project(promptContractSchema.strip(), value, prefixes);
export const projectRubric = (value: unknown, prefixes: readonly string[]) =>
  project(promptRubricSchema.strip(), value, prefixes);
export const projectCase = (value: unknown, prefixes: readonly string[]) =>
  project(promptTestCaseSchema.strip(), value, prefixes);
export function projectHistory(rows: PromptTestCaseRun["history"], prefixes: readonly string[]) {
  return rows.map((row) =>
    safeFields(
      {
        id: row.id,
        run_id: row.run_id,
        best_model: row.best_model,
        avg_score: row.avg_score,
        contract_pass: row.contract_pass,
        model_count: row.model_count,
        avg_cost_krw: row.avg_cost_krw,
        avg_latency_ms: row.avg_latency_ms,
        created_at: row.created_at,
      },
      prefixes,
    ),
  );
}
export function projectRun(
  value: PromptTestCaseRun,
  prefixes: readonly string[],
  expectedModels: readonly string[],
): PromptTestCaseRun {
  if (value.status !== "completed" || !value.run_id || !labIDAllowed(value.run_id, prefixes))
    throw labError("실행 응답을 확인할 수 없습니다. 이력을 확인한 뒤 다시 작업하세요.", "prompt_lab_unknown");
  if (
    value.model_count !== expectedModels.length ||
    value.results.length !== expectedModels.length ||
    new Set(value.results.map((row) => row.model)).size !== expectedModels.length ||
    value.results.some((row) => !row.model || !expectedModels.includes(row.model))
  )
    throw labError("검토한 모델과 실행 응답이 일치하지 않습니다.", "prompt_lab_unknown");
  if (value.best_model && !expectedModels.includes(value.best_model))
    throw labError("최고 점수 모델을 확인할 수 없습니다.", "prompt_lab_unknown");
  return {
    status: value.status,
    run_id: value.run_id,
    best_model:
      typeof value.best_model === "string" && containsPotentialSecret(value.best_model, prefixes)
        ? hiddenLabText
        : value.best_model,
    avg_score: value.avg_score,
    contract_applied: value.contract_applied,
    contract_pass: value.contract_pass,
    model_count: value.model_count,
    results: value.results.map((row) =>
      safeFields(
        {
          model: row.model,
          score: row.score,
          verdict: row.verdict,
          contract_pass: row.contract_pass,
          contract_errors: row.contract_errors?.map((text) =>
            containsPotentialSecret(text, prefixes) ? hiddenLabText : text,
          ),
          cost_krw: row.cost_krw,
          latency_ms: row.latency_ms,
          status: row.status,
        },
        prefixes,
      ),
    ),
    history: [],
  };
}
export function labModels(value: string | null | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
}
export function labExecutionModels(value: string | null | undefined): string[] | undefined {
  const models = labModels(value);
  if (!models) return undefined;
  const selected = [...new Set(models.map((model) => model.trim()).filter(Boolean))].slice(0, 5);
  return selected.length ? selected : undefined;
}
