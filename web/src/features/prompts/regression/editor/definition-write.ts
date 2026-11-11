import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import { regressionId, safeRegressionText } from "../regression-model";
import {
  definitionSignature,
  promptBody,
  workflowBody,
  type DefinitionTarget,
  type DefinitionValues,
} from "./definition-form";
import { definitionError } from "./definition-messages";

const api = endpoints.domains.prompts.golden;
const readOptions = { routeId: regressionId, retryUnauthorized: false, cache: "no-store" } as const;
export async function currentDefinition(
  target: DefinitionTarget,
  signal?: AbortSignal,
): Promise<DefinitionTarget> {
  if (target.kind === "prompt") {
    const data = await apiClient.request(api.prompts, { ...readOptions, query: { limit: 1 }, signal });
    return { ...target, original: data.golden_prompts.find((row) => row.id === target.id) };
  }
  const data = await apiClient.request(api.workflows, { ...readOptions, signal });
  return { ...target, original: data.workflows.find((row) => row.id === target.id) };
}
export async function saveDefinition(
  target: DefinitionTarget,
  values: DefinitionValues,
  assertCurrent: () => void,
  read = currentDefinition,
) {
  assertCurrent();
  const latest = await read(target);
  assertCurrent();
  if (
    latest.original?.updated_at !== target.original?.updated_at ||
    definitionSignature(latest) !== definitionSignature(target)
  )
    throw definitionError("golden_changed");
  // This is a fresh read, not a server compare-and-swap guarantee.
  let dispatched = false;
  try {
    assertCurrent();
    dispatched = true;
    let acknowledgment: DefinitionTarget;
    if (target.kind === "prompt") {
      const response = await apiClient.request(api.savePrompt, {
        ...readOptions,
        body: promptBody(target.id, values),
      });
      if (response.results.length) throw definitionError("golden_unknown");
      acknowledgment = { kind: "prompt", id: response.golden_prompt.id, original: response.golden_prompt };
    } else {
      const response = await apiClient.request(api.saveWorkflow, {
        ...readOptions,
        body: workflowBody(target.id, values),
      });
      acknowledgment = { kind: "workflow", id: response.id, original: response };
    }
    if (definitionSignature(acknowledgment) !== definitionSignature(target, values))
      throw definitionError("golden_unknown");
    assertCurrent();
  } catch (error) {
    const rejected = isAppError(error) && [400, 401, 403, 405, 413].includes(error.status ?? 0);
    if (dispatched && !rejected)
      throw new AppError("저장 상태 확인 필요", {
        kind: "permission",
        code: "golden_unknown",
        requestId: isAppError(error) ? error.requestId : undefined,
      });
    throw error;
  }
}
export async function confirmDefinition(
  target: DefinitionTarget,
  values: DefinitionValues,
  assertCurrent: () => void,
  read = currentDefinition,
) {
  assertCurrent();
  const latest = await read(target);
  assertCurrent();
  if (definitionSignature(latest) !== definitionSignature(target, values))
    throw definitionError("golden_unmatched");
}
/** No raw response/body/server message in mutation state or rendered errors. */
export function safeDefinitionError(error: unknown, prefixes: readonly string[]) {
  if (!isAppError(error)) return new AppError("저장 상태를 확인하지 못했습니다.", { kind: "network" });
  return new AppError("저장 상태를 확인하지 못했습니다.", {
    kind: error.kind,
    status: error.status,
    code: error.code,
    requestId:
      error.requestId && safeRegressionText(error.requestId, prefixes) === error.requestId
        ? error.requestId
        : undefined,
  });
}
