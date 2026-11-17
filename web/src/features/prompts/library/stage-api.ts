import { apiClient } from "@/shared/api/client";
import { stageEndpoints, stagePageSchema, type StageQuery } from "@/shared/api/domains/prompt-stages";
import { libraryError, libraryRouteId, projectLibrary } from "./library-model";
export async function readPromptStages(query: StageQuery, prefixes: readonly string[], signal: AbortSignal) {
  const result = await apiClient.request(stageEndpoints.list, {
    query,
    signal,
    cache: "no-store",
    routeId: libraryRouteId,
  });
  if (
    result.limit !== query.limit ||
    result.offset !== query.offset ||
    result.stage !== query.stage ||
    result.window !== query.window ||
    result.items.length > query.limit ||
    (result.items.length > 0 && result.total < query.offset + result.items.length) ||
    new Set(result.items.map((row) => row.reference)).size !== result.items.length ||
    new Set(result.criteria.map((row) => row.stage)).size !== 2 ||
    result.items.some(
      (row) =>
        (query.stage !== "all" && row.stage !== query.stage) ||
        row.errors > row.calls ||
        (row.can_change && (row.revision === "" || row.stage === "unknown")) ||
        (!row.registered && (row.stage !== "experiment" || row.updated_at !== null)),
    )
  )
    throw libraryError();
  const projected = projectLibrary(stagePageSchema, result, prefixes);
  projected.items = projected.items.map((row, index) => {
    const original = result.items[index];
    return row.name !== original?.name || row.version !== original.version
      ? { ...row, can_change: false, revision: "" }
      : row;
  });
  // A display redaction must never become a different mutation identity or
  // silently corrupt an enum/reference in the cached contract.
  if (!stagePageSchema.safeParse(projected).success) throw libraryError();
  return projected;
}
