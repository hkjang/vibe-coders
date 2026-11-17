import { apiClient } from "@/shared/api/client";
import { runPageEndpoint, type RunPageQuery } from "@/shared/api/domains/redteam-run-page";
import { AppError } from "@/shared/api/error";
import { containsPotentialSecret } from "@/shared/security/secrets";

export async function readRunHistory(query: RunPageQuery, prefixes: readonly string[], signal: AbortSignal) {
  const response = await apiClient.request(runPageEndpoint, {
    query,
    signal,
    cache: "no-store",
    routeId: "security.redteam",
  });
  const invalid =
    response.offset !== query.offset ||
    response.limit !== query.limit ||
    response.runs.length > query.limit ||
    response.runs.length !== Math.min(query.limit, Math.max(0, response.total - query.offset)) ||
    new Set(response.runs.map((run) => run.id)).size !== response.runs.length ||
    response.runs.some(
      (run) =>
        Object.values(run).some(
          (value) => typeof value === "string" && containsPotentialSecret(value, prefixes),
        ) ||
        (query.run_id && run.id !== query.run_id) ||
        (query.campaign_id && run.campaign_id !== query.campaign_id) ||
        (query.source_result_id && run.source_result_id !== query.source_result_id) ||
        (query.review_id && run.review_id !== query.review_id) ||
        (query.status && run.status !== query.status) ||
        (query.mode && run.mode !== query.mode) ||
        (query.kind === "replay" && !run.source_result_id) ||
        (query.kind === "campaign" && Boolean(run.source_result_id)),
    );
  if (invalid) throw new AppError("실행 이력 응답을 확인하지 못했습니다.", { kind: "contract" });
  return response;
}
