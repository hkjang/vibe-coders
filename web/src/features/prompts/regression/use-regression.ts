import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { projectPrompts, projectWorkflows, regressionId } from "./regression-model";

export function useGoldenPrompts(
  owner: FeatureReadOwner,
  limit: number,
  promptID?: string,
  enabled = true,
  refresh = true,
) {
  const { credentialPrefixes } = useAuth();
  const interval = useRefreshInterval();
  return useQuery({
    queryKey: featureOwnedKey([regressionId, "prompts", limit, promptID ?? ""], owner),
    enabled,
    gcTime: 0,
    retry: false,
    refetchInterval: refresh ? interval : false,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(endpoints.domains.prompts.golden.prompts, {
        query: { limit, ...(promptID === undefined ? {} : { prompt_id: promptID }) },
        signal,
        routeId: regressionId,
        cache: "no-store",
      });
      assertFeatureRead(owner, signal);
      if (promptID !== undefined && data.results.some((row) => row.prompt_id !== promptID))
        throw new AppError("선택한 프롬프트와 실행 결과의 대상이 일치하지 않습니다.", { kind: "contract" });
      return projectPrompts(data, credentialPrefixes);
    },
  });
}
export function useGoldenWorkflows(owner: FeatureReadOwner, refresh = true) {
  const { credentialPrefixes } = useAuth();
  const interval = useRefreshInterval();
  return useQuery({
    queryKey: featureOwnedKey([regressionId, "workflows"], owner),
    gcTime: 0,
    retry: false,
    refetchInterval: refresh ? interval : false,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(endpoints.domains.prompts.golden.workflows, {
        signal,
        routeId: regressionId,
        cache: "no-store",
      });
      assertFeatureRead(owner, signal);
      return projectWorkflows(data, credentialPrefixes);
    },
  });
}
