import type { PromptStageBulkReview } from "../../src/shared/api/generated";
import { stagePage, stageRow } from "./prompt-stage-data";

export function bulkStageReview(
  now = Date.now(),
  count = 2,
  window: PromptStageBulkReview["window"] = "7d",
): PromptStageBulkReview {
  const span = { "1h": 3600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 }[window];
  return {
    window,
    since: new Date(now - span).toISOString(),
    until: new Date(now).toISOString(),
    expires_at: new Date(now + 300000).toISOString(),
    revision: count ? "r".repeat(43) : "",
    observed_count: count + 1,
    ignored_count: 1,
    blocked_count: 0,
    items: Array.from({ length: count }, (_, index) => ({
      ...stageRow,
      reference: String(index).padStart(43, "a"),
      name: `승격 대상 ${index + 1}`,
      stage: index % 2 ? "validation" : "experiment",
      eligible_stage: index % 2 ? "production" : "validation",
      calls: 60,
      errors: 0,
      evaluation_failures: 0,
    })),
    criteria: stagePage().criteria,
  };
}
