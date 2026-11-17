import { apiClient } from "@/shared/api/client";
import { withPathParams } from "@/shared/api/domains/redteam";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";

export async function readPreflight(campaignId: string) {
  const result = await apiClient.request(
    withPathParams(endpoints.domains.redteam.campaigns.dryRun, { id: campaignId }),
    { routeId: "security.redteam", retryUnauthorized: false },
  );
  if (result.campaign_id !== campaignId) {
    throw new AppError("사전 점검 대상이 요청한 캠페인과 다릅니다.", { kind: "contract" });
  }
  return result;
}
