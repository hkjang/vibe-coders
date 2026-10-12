import { withPathParams } from "@/features/agents/endpoint-path";
import { workflowUpsertBody, type WorkflowFormOutput } from "./workflow-form";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatNumber } from "@/shared/utils/format";

export const workflowsKey = ["agents", "workflows"] as const;

export function useWorkflowMutations({
  assertCurrent,
  ownsResult,
  onRemoved,
}: {
  assertCurrent: () => void;
  ownsResult: () => boolean;
  onRemoved: (id: string) => void;
}) {
  const upsert = useMutationFeedback({
    ownsResult,
    mutate: (variables: { values: WorkflowFormOutput; id?: string }) => {
      assertCurrent();
      return apiClient.request(endpoints.domains.agents.workflows.upsert, {
        body: workflowUpsertBody(variables.values, variables.id),
        routeId: "agents.workflows",
        retryUnauthorized: false,
      });
    },
    invalidates: [workflowsKey],
    successMessage: "워크플로를 저장했습니다.",
    errorMessage: "워크플로를 저장하지 못했습니다.",
  });
  const remove = useMutationFeedback({
    ownsResult,
    mutate: (id: string) => {
      assertCurrent();
      return apiClient.request(endpoints.domains.agents.workflows.remove, {
        query: { id },
        routeId: "agents.workflows",
        retryUnauthorized: false,
      });
    },
    invalidates: [workflowsKey],
    successMessage: "워크플로를 삭제했습니다.",
    errorMessage: "워크플로를 삭제하지 못했습니다.",
    onSuccess: (_result, id) => onRemoved(id),
  });
  const publish = useMutationFeedback({
    ownsResult,
    mutate: (variables: { id: string; note: string }) => {
      assertCurrent();
      return apiClient.request(
        withPathParams(endpoints.domains.agents.workflows.publish, { id: variables.id }),
        {
          body: { note: variables.note },
          routeId: "agents.workflows",
          retryUnauthorized: false,
        },
      );
    },
    invalidates: [workflowsKey],
    successMessage: (result) => `워크플로를 게시했습니다. (v${formatNumber(result.version ?? 0)})`,
    errorMessage: "워크플로를 게시하지 못했습니다.",
  });
  return { upsert, remove, publish };
}
