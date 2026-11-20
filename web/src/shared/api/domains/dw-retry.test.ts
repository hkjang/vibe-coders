import { expect, it } from "vitest";
import { dwRetryEndpoints } from "./dw-retry";
import { sanitizeAppRouteSearch } from "@/shared/security/app-route-query";
const revision = "a".repeat(64);
const id = `dwr_${revision}`;
const dimension = {
  dimension: "model",
  since: "2026-11-01",
  until: "2026-11-20",
  estimated_rows: 10,
  sent_rows: 0,
  status: "queued",
  issue: "",
};
const review = {
  revision,
  run_id: id,
  reviewed_at: "2026-11-20T00:00:00Z",
  expires_at: "2026-11-20T00:05:00Z",
  all: false,
  eligible_dimensions: 1,
  estimated_rows: 10,
  dimensions: [dimension],
};
it("검토 응답은 검토 ID와 작업 ID의 일치를 요구한다", () => {
  expect(dwRetryEndpoints.review.schema.safeParse(review).success).toBe(true);
  expect(
    dwRetryEndpoints.review.schema.safeParse({ ...review, run_id: `dwr_${"b".repeat(64)}` }).success,
  ).toBe(false);
  for (const mutation of [
    { estimated_rows: -1 },
    { dimensions: null },
    { eligible_dimensions: undefined },
    { estimated_rows: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(dwRetryEndpoints.review.schema.safeParse({ ...review, ...mutation }).success).toBe(false);
});
it("이전 동기 API 성공 응답을 새 작업 접수로 잘못 해석하지 않는다", () => {
  expect(
    dwRetryEndpoints.start.schema.safeParse({ recovered_dimensions: 1, sent_rows: 10, failed: {} }).success,
  ).toBe(false);
  expect(dwRetryEndpoints.job.schema.safeParse({ id, status: "succeeded" }).success).toBe(false);
});
it("URL에는 정확한 작업 참조만 보존하고 사유나 중복 작업 주소는 버린다", () => {
  const result = sanitizeAppRouteSearch(
    "/data/warehouse",
    `tab=pipeline&retry_job=${id}&reason=private+reason`,
    ["dwr_"],
  );
  expect(result.search).toContain(`retry_job=${id}`);
  expect(result.search).not.toContain("reason");
  for (const query of [
    `retry_job=${id}&retry_job=${id}`,
    "retry_job=dwr_short",
    `retry_job=${id.toUpperCase()}`,
  ])
    expect(sanitizeAppRouteSearch("/data/warehouse", query).search).toBe("");
});
