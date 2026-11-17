import { afterEach, expect, it, vi } from "vitest";
import { evidenceReadSchema, resultsReadSchema } from "@/shared/api/domains/redteam-evidence-read";
import { mockApi } from "@/test/api";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { evidenceReadFixture } from "./evidence-read-fixture";
import { readEvidence, readResults } from "./evidence-read-api";
import { replayReviewFixture, replayOutcomeFixture } from "./reviewed-replay-fixture";
const owner: FeatureReadOwner = {
  id: 1,
  marker: "test",
  readable: true,
  denied: false,
  isCurrent: () => true,
  restart: () => undefined,
};
afterEach(() => vi.restoreAllMocks());
it("마스킹 응답은 원문·도구 인수·임의 메타와 이전 응답 형식을 거부한다", () => {
  const base = evidenceReadFixture();
  expect(evidenceReadSchema.parse(base)).toEqual(base);
  expect(evidenceReadSchema.parse(evidenceReadFixture(true)).masked).toBe(false);
  for (const input of [
    { evidence: base.evidence },
    { ...base, evidence: { ...base.evidence, raw_prompt: "원문" } },
    { ...base, evidence: { ...base.evidence, raw_response: "원문" } },
    { ...base, evidence: { ...base.evidence, tool_calls: [{ arguments: "원문" }] } },
    { ...base, evidence: { ...base.evidence, headers_summary: { seed_template: "원문" } } },
    { ...evidenceReadFixture(true), raw_allowed: false },
    { ...evidenceReadFixture(true), tool_call_count: 0 },
  ])
    expect(evidenceReadSchema.safeParse(input).success).toBe(false);
});
it("실행 결과는 마스킹 계약과 결과·프롬프트의 소속을 확인한다", () => {
  const run = replayOutcomeFixture().runs[0];
  if (!run) throw new Error("missing run");
  const result = { ...replayReviewFixture().source_result, run_id: run.id };
  const base = { run, results: [result], prompts: { [result.id]: "마스킹된 요청" }, count: 1, masked: true };
  expect(resultsReadSchema.safeParse(base).success).toBe(true);
  for (const input of [
    { ...base, masked: false },
    { ...base, masked: undefined },
    { ...base, count: 2 },
    { ...base, results: [{ ...result, run_id: "another" }] },
    { ...base, results: [result, result], count: 2 },
    { ...base, prompts: { other: "마스킹된 요청" } },
    { ...base, results: [{ ...result, raw_prompt: "원문" }] },
  ])
    expect(resultsReadSchema.safeParse(input).success).toBe(false);
});
it.each([false, true])("명시적인 표시 범위만 요청하고 다른 증적의 응답을 거부한다: %s", async (reveal) => {
  const api = mockApi({
    "GET /admin/redteam/results/public-result/evidence": () => evidenceReadFixture(reveal),
  });
  await readEvidence("public-result", reveal, owner, new AbortController().signal);
  expect(api.calls[0]?.options.query).toEqual({ view: "app", ...(reveal ? { reveal: "raw" } : {}) });
  await expect(readEvidence("another", reveal, owner, new AbortController().signal)).rejects.toMatchObject({
    kind: "contract",
  });
});
it("늦게 온 원문은 계정·조회 수명이 바뀌면 반환하지 않는다", async () => {
  let current = true;
  const scope = { ...owner, isCurrent: () => current };
  mockApi({
    "GET /admin/redteam/results/public-result/evidence": () => {
      current = false;
      return evidenceReadFixture(true);
    },
  });
  await expect(
    readEvidence("public-result", true, scope, new AbortController().signal),
  ).rejects.toMatchObject({ kind: "aborted" });
});
it("다른 실행 응답 또는 조회 범위가 바뀐 증적을 거부한다", async () => {
  mockApi({
    "GET /admin/redteam/runs/wanted/results": () => ({ run: { id: "another" } }),
    "GET /admin/redteam/results/public-result/evidence": () => evidenceReadFixture(true),
  });
  await expect(readResults("wanted", owner, new AbortController().signal)).rejects.toMatchObject({
    kind: "contract",
  });
  await expect(
    readEvidence("public-result", false, owner, new AbortController().signal),
  ).rejects.toMatchObject({ kind: "contract" });
});

it("다른 증적 ID의 응답은 원문 조회에서도 거부한다", async () => {
  mockApi({
    "GET /admin/redteam/results/public-result/evidence": () => evidenceReadFixture(true, "another"),
  });
  await expect(
    readEvidence("public-result", true, owner, new AbortController().signal),
  ).rejects.toMatchObject({ kind: "contract" });
});
