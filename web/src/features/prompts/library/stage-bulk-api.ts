import { apiClient } from "@/shared/api/client";
import { AppError, isAppError } from "@/shared/api/error";
import { stageBulkEndpoints, stageBulkReviewSchema } from "@/shared/api/domains/prompt-stage-bulk";
import type { StageQuery } from "@/shared/api/domains/prompt-stages";
import { libraryError, libraryRouteId, projectLibrary } from "./library-model";
import { stageBulkMessages as text } from "./stage-bulk-messages";

export async function readStageBulkReview(
  window: StageQuery["window"],
  prefixes: readonly string[],
  signal: AbortSignal,
) {
  try {
    const result = await apiClient.request(stageBulkEndpoints.review, {
      query: { view: "promotion-review", window },
      signal,
      cache: "no-store",
      routeId: libraryRouteId,
    });
    const duration = { "1h": 3600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 }[window];
    if (
      result.window !== window ||
      result.observed_count !== result.items.length + result.ignored_count ||
      result.blocked_count !== result.items.filter((row) => !row.can_change).length ||
      Date.parse(result.until) - Date.parse(result.since) !== duration ||
      Date.parse(result.expires_at) - Date.parse(result.until) !== 300000 ||
      new Set(result.items.map((row) => row.reference)).size !== result.items.length ||
      new Set(result.criteria.map((row) => row.stage)).size !== 2 ||
      (result.revision !== "") !== (result.items.length > 0 && result.blocked_count === 0) ||
      result.items.some(
        (row) =>
          row.errors > row.calls ||
          !(
            (row.stage === "experiment" && row.eligible_stage === "validation") ||
            (row.stage === "validation" && row.eligible_stage === "production")
          ),
      )
    )
      throw libraryError();
    const projected = projectLibrary(stageBulkReviewSchema, result, prefixes);
    // Never apply a plan whose displayed identities differ from the reviewed set.
    projected.items = projected.items.map((row, i) =>
      row.name !== result.items[i]?.name || row.version !== result.items[i]?.version
        ? { ...row, can_change: false, revision: "" }
        : row,
    );
    projected.blocked_count = projected.items.filter((row) => !row.can_change).length;
    if (projected.blocked_count) projected.revision = "";
    if (!stageBulkReviewSchema.safeParse(projected).success) throw libraryError();
    return projected;
  } catch (error) {
    if (isAppError(error) && error.code === "prompt_stage_bulk_limit")
      throw new AppError(text.limit, { kind: "contract", status: 400, code: "prompt_library_bulk_limit" });
    throw error;
  }
}
