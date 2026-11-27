import { describe, expect, it } from "vitest";

import {
  insightsClassificationEndpoints as api,
  workPolicyRejectionSchema,
  workReclassifyQuerySchema,
  workReviewQuerySchema,
} from "@/shared/api/domains/insights-classification";

// The server documents these responses as open objects, so the console's schemas
// are the contract. These cases pin what the screens rely on: missing and null
// members become usable defaults, and nothing unknown is dropped from the policy.

describe("classification API schemas", () => {
  it("fills in what a sparse policy leaves out and keeps unknown members for the next save", () => {
    const parsed = api.policy.schema.parse({
      config: {
        categories: [
          {
            id: "dev",
            name: "소프트웨어 개발",
            rules: { keywords: null, future_hint: ["x"] },
            color: "blue",
          },
          { id: "dev.codegen", parent_id: "dev", enabled: false, merged_into: null },
        ],
        action_types: null,
        future_section: { a: 1 },
      },
      revision: 3,
    });
    expect(parsed.revision).toBe(3);
    expect(parsed.published_version).toBe(0);
    expect(parsed.dirty).toBe(false);
    expect(parsed.defaults.thresholds.accept).toBe(0.72);
    const [dev, codegen] = parsed.config.categories;
    expect(dev).toMatchObject({
      id: "dev",
      parent_id: "",
      enabled: true,
      merged_into: "",
      examples: [],
      color: "blue",
      rules: { keywords: [], mcp_tools: [], weight: 1, future_hint: ["x"] },
    });
    expect(codegen).toMatchObject({ enabled: false, merged_into: "", rules: { keywords: [], weight: 1 } });
    expect(parsed.config.action_types).toEqual([]);
    expect(parsed.config.thresholds).toEqual({
      accept: 0.72,
      review_below: 0.5,
      min_evidence: 2,
      min_group_size: 3,
    });
    expect(parsed.config.llm).toEqual({ system_prompt: "", max_input_chars: 1500 });
    expect(parsed.config.baselines).toEqual([]);
    expect((parsed.config as Record<string, unknown>).future_section).toEqual({ a: 1 });
  });

  it("refuses a policy whose category has no id", () => {
    expect(api.policy.schema.safeParse({ config: { categories: [{ name: "이름만" }] } }).success).toBe(false);
  });

  it("reads the issues of a rejected save", () => {
    const parsed = workPolicyRejectionSchema.parse({
      error: { code: "work_policy_invalid" },
      issues: [{ path: "thresholds.accept", message: "확정 기준은 0과 1 사이여야 합니다." }],
    });
    expect(parsed.issues).toEqual([
      { path: "thresholds.accept", message: "확정 기준은 0과 1 사이여야 합니다." },
    ]);
    expect(workPolicyRejectionSchema.safeParse({ error: {} }).success).toBe(false);
  });

  it("accepts a test result that names its category by reference or by bare id", () => {
    const bare = api.test.schema.parse({ result: { category_id: "other", confidence: 0.2 } });
    expect(bare.result).toMatchObject({
      category: null,
      category_id: "other",
      tags: [],
      technologies: [],
      status: "",
    });
    expect(bare.candidates).toEqual([]);
    expect(bare.llm).toEqual({ used: false, error: "", code: "" });
    const referenced = api.test.schema.parse({
      result: { category: { id: "dev.codegen", name: "코드 생성" }, tags: ["rest"] },
      candidates: [{ category: { id: "dev.codegen" }, score: 2.5, evidence: null }],
      llm: { used: true },
    });
    expect(referenced.result.category).toMatchObject({ id: "dev.codegen", level: 1, enabled: true });
    expect(referenced.candidates[0]).toMatchObject({ score: 2.5, evidence: [] });
    expect(referenced.llm).toEqual({ used: true, error: "", code: "" });
    // A spent per-minute LLM budget is a known refusal with its own code and a Korean message.
    const budget = api.test.schema.parse({
      result: { category_id: "other" },
      llm: { used: false, error: "분당 LLM 예산을 모두 썼습니다.", code: "llm_budget_exhausted" },
    });
    expect(budget.llm).toEqual({
      used: false,
      error: "분당 LLM 예산을 모두 썼습니다.",
      code: "llm_budget_exhausted",
    });
  });

  it("keeps a missing accuracy as null instead of zero", () => {
    const parsed = api.evaluate.schema.parse({ sample: 4, accuracy: null, note: "표본 부족" });
    expect(parsed).toMatchObject({
      sample: 4,
      accuracy: null,
      top_accuracy: null,
      by_category: [],
      confusions: [],
    });
    expect(api.evaluate.schema.parse({ accuracy: 0.5, top_accuracy: 0.75 })).toMatchObject({
      accuracy: 0.5,
      top_accuracy: 0.75,
    });
  });

  it("reads a review page without a summary and a job that reports rebuilt days either way", () => {
    const review = api.review.schema.parse({ rows: null, count: 0 });
    expect(review.rows).toEqual([]);
    expect(review.summary).toEqual({ review: 0, unclassified: 0, failed: 0, new_category_hints: [] });

    const counted = api.reclassifyJob.schema.parse({
      id: "job-1",
      status: "running",
      progress: { total: 10 },
    });
    expect(counted.progress).toMatchObject({
      total: 10,
      done: 0,
      changed: 0,
      failed: 0,
      days_rebuilt: 0,
      kept_no_text: 0,
      previewed: 0,
    });
    // How many the preview counted; the server now runs the confirmed preview even when it has moved.
    expect(
      api.reclassifyJob.schema.parse({ id: "job-1", progress: { total: 12, previewed: 10 } }).progress,
    ).toMatchObject({ total: 12, previewed: 10 });
    const listed = api.reclassifyJob.schema.parse({
      id: "job-1",
      status: "succeeded",
      progress: { total: 10, done: 10, days_rebuilt: ["2026-11-25", "2026-11-26"] },
    });
    expect(listed.progress.days_rebuilt).toEqual(["2026-11-25", "2026-11-26"]);
    expect(api.reclassifyJob.schema.parse({ id: "job-2" }).progress.total).toBe(0);

    const preview = api.reclassifyPreview.schema.parse({
      revision: "r1",
      total: 5,
      active_job: { id: "job-9" },
    });
    expect(preview).toMatchObject({
      by_status: {},
      by_method: {},
      manual_kept: 0,
      no_text_kept: 0,
      no_text_capped: false,
      active_job: { id: "job-9" },
    });
    expect(api.reclassifyPreview.schema.parse({}).active_job).toBeNull();
    expect(api.reclassifyPreview.schema.parse({ no_text_kept: 50000, no_text_capped: true })).toMatchObject({
      no_text_kept: 50000,
      no_text_capped: true,
    });
  });

  it("only sends query parameters the routes document", () => {
    expect(
      workReviewQuerySchema.safeParse({ status: "review", max_conf: 0.5, limit: 50, offset: 0 }).success,
    ).toBe(true);
    expect(workReviewQuerySchema.safeParse({ status: "classified" }).success).toBe(false);
    expect(workReviewQuerySchema.safeParse({ max_conf: 1.5 }).success).toBe(false);
    expect(workReviewQuerySchema.safeParse({ team: "platform" }).success).toBe(false);
    // The server refuses an offset past where list counts stop.
    expect(workReviewQuerySchema.safeParse({ offset: 100_000 }).success).toBe(true);
    expect(workReviewQuerySchema.safeParse({ offset: 100_001 }).success).toBe(false);
    expect(
      workReclassifyQuerySchema.safeParse({ from: "2026-11-01", to: "2026-11-07", method: "llm" }).success,
    ).toBe(true);
    expect(workReclassifyQuerySchema.safeParse({ from: "11/01/2026" }).success).toBe(false);
    expect(api.reclassifyRun.querySchema?.safeParse({ reviewed: "1" }).success).toBe(true);
    expect(api.reclassifyRun.querySchema?.safeParse({ reviewed: "0" }).success).toBe(false);
    expect(api.review.querySchema).toBeDefined();
    expect(api.reclassifyPreview.querySchema).toBeDefined();
  });
});
