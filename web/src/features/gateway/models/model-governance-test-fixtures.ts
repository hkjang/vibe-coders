import type { ModelContract, ModelContractRun, ModelDeprecation } from "@/shared/api/domains/gateway.schemas";

// Public synthetic component inputs. mockApi replaces the client call and does
// not prove wire DTO validation or real server persistence/authorization.
export const contractFixture: ModelContract = {
  id: "mcon_original",
  name: "기존 계약",
  task_type: "code_review",
  min_quality_score: 70,
  min_golden_pass_rate: 0.8,
  min_success_rate: 0.95,
  max_latency_ms: 4000,
  max_avg_cost_krw: 0.0000003,
  enabled: true,
  created_by: "synthetic-audit-actor",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};
export const deprecationFixture: ModelDeprecation = {
  id: "moddep_original",
  model_glob: "old-*",
  replacement: "new-model",
  sunset_date: "2026-12-31",
  message: "이전 계획",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};
export const runFixture: ModelContractRun = {
  model: "public-model",
  window: "2026-09-01T00:00:00Z",
  replaceable: true,
  have_metrics: { quality: true, latency: true, cost: true },
  note: "stored observation only",
  results: [
    {
      contract_id: contractFixture.id,
      contract_name: contractFixture.name,
      task_type: "code_review",
      verdict: "warn",
      replaceable: true,
      checks: [
        { dimension: "quality_score", threshold: 70, actual: 72, status: "warn" },
        { dimension: "avg_latency_ms", threshold: 4000, actual: 100, status: "pass" },
        { dimension: "avg_cost_krw", threshold: 1, actual: 0.0000003, status: "pass" },
      ],
    },
  ],
  failing_samples: [],
};
