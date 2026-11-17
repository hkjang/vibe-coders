import { afterEach, expect, it, vi } from "vitest";
import { mockApi } from "@/test/api";
import { runPageSchema, runPageQuerySchema } from "@/shared/api/domains/redteam-run-page";
import { readRunHistory } from "./run-history-api";

const run = {
  id: "run-1",
  campaign_id: "campaign",
  target_id: "target",
  created_at: "2026-11-01T00:00:00Z",
  started_at: "2026-11-01T00:00:00Z",
  ended_at: "",
  mode: "dry-run",
  status: "passed",
  total_cases: 1,
  failed_cases: 0,
  risk_score: 0,
  cost_krw: 0,
};
const page = () => ({ runs: [run], total: 1, offset: 0, limit: 25, generated_at: "2026-11-17T00:00:00Z" });
afterEach(() => vi.restoreAllMocks());
it("이력 계약은 구버전 응답·증적·잘못된 페이지를 거부한다", () => {
  expect(runPageSchema.safeParse(page()).success).toBe(true);
  for (const input of [
    { runs: [run], count: 1 },
    { ...page(), offset: -1 },
    { ...page(), runs: [{ ...run, raw_prompt: "private" }] },
    { ...page(), runs: [{ ...run, total_cases: -1 }] },
    { ...page(), generated_at: "invalid" },
  ])
    expect(runPageSchema.safeParse(input).success).toBe(false);
  expect(
    runPageQuerySchema.safeParse({ view: "page", limit: 25, offset: 0, from: "2026-11-01T00:00:00Z" })
      .success,
  ).toBe(false);
});
it.each(["offset", "count", "duplicate", "filter", "credential"])(
  "서버 응답이 요청 조건과 맞지 않으면 표시하지 않는다: %s",
  async (fault) => {
    const response = page();
    if (fault === "offset") response.offset = 25;
    if (fault === "count") response.total = 2;
    if (fault === "duplicate") {
      response.runs.push(run);
      response.total = 2;
    }
    if (fault === "filter") response.runs = [{ ...run, status: "stopped" }];
    if (fault === "credential") response.runs = [{ ...run, target_id: "sk-proj-privatecredential12345678" }];
    mockApi({ "GET /admin/redteam/runs": () => response });
    await expect(
      readRunHistory(
        { view: "page", limit: 25, offset: 0, status: "passed" },
        [],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "contract" });
  },
);
