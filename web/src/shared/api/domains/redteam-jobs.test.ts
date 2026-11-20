import { expect, it, vi } from "vitest";
import { redTeamJobSchema, redTeamJobEndpoints } from "./redteam-jobs";
import { ApiClient } from "@/shared/api/client";
import { withPathParams } from "./redteam";
import { executionJobFixture } from "@/features/security/redteam/job-fixture";

it("공통 API 전송기가 작업 접수와 상태 조회 쿼리를 실제 요청으로 직렬화한다", async () => {
  const job = executionJobFixture();
  const transport = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(job), {
        status: init?.method === "POST" ? 202 : 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const client = new ApiClient({ fetch: transport });
  const path = { id: job.campaign_id };
  const body = { review_token: "r".repeat(43), proxy_key: "public-key" };
  await expect(
    client.request(withPathParams(redTeamJobEndpoints.start, path), {
      query: { job: "1" },
      body,
      retryUnauthorized: false,
    }),
  ).resolves.toMatchObject({ id: job.id });
  await expect(
    client.request(withPathParams(redTeamJobEndpoints.read, path), { query: { job_id: job.id } }),
  ).resolves.toMatchObject({ id: job.id });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
    `/admin/redteam/campaigns/${job.campaign_id}/run-reviewed?job=1`,
    `/admin/redteam/campaigns/${job.campaign_id}/run-reviewed?job_id=${job.id}`,
  ]);
  expect(transport.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(body));
  expect(transport.mock.calls[1]?.[1]?.body).toBeUndefined();
});

it("진행·완료 작업을 검증하고 내부 소유자나 키를 응답으로 받지 않는다", () => {
  expect(redTeamJobSchema.safeParse(executionJobFixture()).success).toBe(true);
  expect(redTeamJobSchema.safeParse(executionJobFixture(true)).success).toBe(true);
  for (const field of ["actor", "worker_token", "proxy_key", "review_token"])
    expect(redTeamJobSchema.safeParse({ ...executionJobFixture(), [field]: "private" }).success).toBe(false);
});
it("검토와 다른 결과·한도 초과·확인되지 않은 완료를 거부한다", () => {
  const job = executionJobFixture(true);
  expect(redTeamJobSchema.safeParse({ ...job, outcome: null }).success).toBe(false);
  expect(redTeamJobSchema.safeParse({ ...job, review_id: "another" }).success).toBe(false);
  expect(redTeamJobSchema.safeParse({ ...job, progress: { ...job.progress, live_calls: 2 } }).success).toBe(
    false,
  );
  expect(
    redTeamJobSchema.safeParse({ ...job, progress: { ...job.progress, completed_cases: 2 } }).success,
  ).toBe(false);
});
