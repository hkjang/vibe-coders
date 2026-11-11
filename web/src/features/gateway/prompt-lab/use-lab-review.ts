import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import type { PromptExperiment, PromptTestCase } from "@/shared/api/domains/gateway.schemas";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { labError, labIDAllowed, projectExperiment, projectCase, safeLabError } from "./prompt-lab-model";
import { promptLabRouteId } from "./use-prompt-lab";

export function useLabReview(owner: FeatureReadOwner) {
  const client = useQueryClient();
  const { credentialPrefixes } = useAuth();
  return async (experiment: PromptExperiment | undefined, testCase?: PromptTestCase) => {
    if (!experiment || !labIDAllowed(experiment.id, credentialPrefixes))
      throw labError("실험을 다시 조회해 주세요.");
    await client.fetchQuery({
      queryKey: featureOwnedKey(["gateway", "prompt-lab", "review", experiment.id], owner),
      staleTime: 0,
      gcTime: 0,
      retry: false,
      queryFn: async ({ signal }) => {
        try {
          assertFeatureRead(owner, signal);
          const data = await apiClient.request(
            withPathParams(endpoints.domains.gateway.promptLab.experiments.detail, { id: experiment.id }),
            {
              signal,
              routeId: promptLabRouteId,
              cache: "no-store",
            },
          );
          assertFeatureRead(owner, signal);
          if (
            !data.experiment ||
            JSON.stringify(projectExperiment(data.experiment, credentialPrefixes)) !==
              JSON.stringify(experiment)
          )
            throw labError("실험 내용이 변경됐습니다. 최신 내용을 확인하고 다시 작업하세요.");
          if (testCase) {
            const matches = data.test_cases.filter(
              (row) => row.id === testCase.id && row.experiment_id === experiment.id,
            );
            if (
              matches.length !== 1 ||
              JSON.stringify(projectCase(matches[0], credentialPrefixes)) !== JSON.stringify(testCase)
            )
              throw labError("테스트 케이스가 변경됐습니다. 최신 내용을 확인하고 다시 작업하세요.");
          }
          return true;
        } catch (error) {
          throw safeLabError(error, credentialPrefixes);
        }
      },
    });
  };
}
