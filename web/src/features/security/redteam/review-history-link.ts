import { versionAtLeast } from "@/config/migration-registry";
import { runQueryKeys, validRunRef } from "@/shared/utils/redteam-run-query";
import type { SearchUpdates } from "@/shared/hooks/use-search-state";

export function reviewHistoryLink(
  backendVersion: string,
  campaignId: string,
  reviewId: string,
  prefixes: readonly string[],
): SearchUpdates | undefined {
  if (
    !versionAtLeast(backendVersion, "v0.86.148") ||
    !campaignId ||
    !reviewId ||
    !validRunRef(campaignId, prefixes) ||
    !validRunRef(reviewId, prefixes)
  )
    return undefined;
  return {
    ...Object.fromEntries(runQueryKeys.map((key) => [key, null])),
    tab: "runs",
    runs_kind: "campaign",
    runs_campaign_id: campaignId,
    runs_review_id: reviewId,
  };
}
