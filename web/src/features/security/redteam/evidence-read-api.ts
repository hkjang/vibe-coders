import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/domains/redteam";
import { AppError } from "@/shared/api/error";
import { assertFeatureRead, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";

export async function readEvidence(
  resultId: string,
  reveal: boolean,
  owner: FeatureReadOwner,
  signal: AbortSignal,
) {
  assertFeatureRead(owner, signal);
  const result = await apiClient.request(
    withPathParams(endpoints.domains.redteam.results.readEvidence, { id: resultId }),
    {
      query: { view: "app", ...(reveal ? { reveal: "raw" as const } : {}) },
      routeId: "security.redteam",
      cache: "no-store",
      signal,
    },
  );
  assertFeatureRead(owner, signal);
  if (result.evidence.result_id !== resultId || result.masked === reveal)
    throw new AppError("선택한 증적의 표시 범위를 확인하지 못했습니다.", { kind: "contract" });
  return result;
}

export async function readResults(runId: string, owner: FeatureReadOwner, signal: AbortSignal) {
  assertFeatureRead(owner, signal);
  const result = await apiClient.request(withPathParams(endpoints.domains.redteam.runs.read, { id: runId }), {
    query: { view: "app" },
    routeId: "security.redteam",
    cache: "no-store",
    signal,
  });
  assertFeatureRead(owner, signal);
  if (result.run.id !== runId)
    throw new AppError("선택한 실행의 결과를 확인하지 못했습니다.", { kind: "contract" });
  return result;
}
