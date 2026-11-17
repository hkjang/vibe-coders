import type { PromptStageWorkspacePage, PromptStageWorkspaceItem } from "../../src/shared/api/generated";
export const stageRow: PromptStageWorkspaceItem = {
  reference: "a".repeat(43),
  name: "업무 요약",
  version: "v1",
  stage: "experiment",
  registered: true,
  can_change: true,
  revision: "b".repeat(43),
  calls: 24,
  errors: 1,
  evaluation_failures: 2,
  eligible_stage: "validation",
  updated_at: "2026-11-16T01:00:00Z",
};
export function stagePage(items: PromptStageWorkspaceItem[] = [{ ...stageRow }]): PromptStageWorkspacePage {
  return {
    items,
    total: items.length,
    offset: 0,
    limit: 25,
    window: "7d",
    stage: "all",
    since: "2026-11-10T04:00:00Z",
    until: "2026-11-17T04:00:00Z",
    criteria: [
      {
        stage: "validation",
        minimum_calls: 20,
        maximum_error_rate: 0.1,
        maximum_evaluation_failures_per_call: 0.2,
      },
      {
        stage: "production",
        minimum_calls: 50,
        maximum_error_rate: 0.05,
        maximum_evaluation_failures_per_call: 0.1,
      },
    ],
  };
}
