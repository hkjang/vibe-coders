import { expect, it } from "vitest";
import { readRedTeamJobRef, validRedTeamJobId } from "./redteam-job-query";
import { sanitizeAppRouteSearch } from "@/shared/security/app-route-query";

const id = `rtj_${"a".repeat(64)}`;
const pair = `execution_job=${id}&job_campaign=public-campaign`;
it("작업 주소는 공개 식별자 쌍만 허용하고 설정된 키 접두사와 구분한다", () => {
  expect(validRedTeamJobId(id)).toBe(true);
  expect(readRedTeamJobRef(new URLSearchParams(pair))).toEqual({ id, campaign: "public-campaign" });
  expect(sanitizeAppRouteSearch("/redteam", pair, ["rtj_"]).search).toBe(`?${pair}`);
});
it.each([
  `execution_job=${id}`,
  "job_campaign=public-campaign",
  `${pair}&job_campaign=other`,
  `${pair}&execution_job=${id}`,
  "execution_job=rtj_short&job_campaign=public-campaign",
  `execution_job=${id}&job_campaign=vc_sk_private-key-material`,
  `execution_job=${id}&job_campaign=..%2Fother`,
])("잘못되거나 민감한 주소 쌍을 제거한다: %s", (search) => {
  expect(readRedTeamJobRef(new URLSearchParams(search))).toBeUndefined();
  const result = sanitizeAppRouteSearch("/app/redteam", search);
  expect(result.search).toBe("");
});
