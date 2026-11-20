import type { ProbeCsvReview } from "../shared/api/domains/redteam-probe-csv-review";

export function probeCsvReviewFixture(): ProbeCsvReview {
  const pack = {
    id: "csv-pack",
    name: "공개 합성 묶음",
    category: "custom",
    severity: "low",
    version: "v7",
    enabled: false,
    requires_approval: false,
  };
  const probe = {
    id: "csv-case",
    pack_id: pack.id,
    case_key: "public_case",
    input_template: "기존 공개 프롬프트",
    expected_policy: "refuse",
    evaluator_type: "rule",
    severity: "low",
    risk_tags: ["public"],
    target_types: ["model"],
  };
  return {
    review_supported: true,
    revision: "a".repeat(64),
    file_sha256: "b".repeat(64),
    imported_cases: 1,
    packs_touched: 1,
    skipped: [],
    counts: { created: 0, updated: 1, unchanged: 1 },
    total_items: 2,
    offset: 0,
    limit: 20,
    has_more: false,
    changes: [
      { kind: "pack", id: pack.id, action: "unchanged", before: pack, after: { ...pack } },
      {
        kind: "case",
        id: probe.id,
        action: "update",
        before: probe,
        after: { ...probe, input_template: "검토한 공개 프롬프트" },
      },
    ],
  };
}
