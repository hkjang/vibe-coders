// Public synthetic data only; no user prompts or provider credentials.
export const labExperiment = {
  id: "public_exp_1",
  title: "요약 품질 비교",
  description: "공개 검증용 실험",
  team: "운영팀",
  owner: "public@example.invalid",
  status: "active",
  created_at: "2030-01-01T00:00:00Z",
  updated_at: "2030-01-01T00:00:00Z",
};
export const labCase = {
  id: "public_case_1",
  experiment_id: labExperiment.id,
  name: "한글 요약 검사",
  messages_hash: "public-hash",
  models_json: '["public-model-a"]',
  contract_id: "public_contract",
  rubric_id: "",
  created_at: "2030-01-02T00:00:00Z",
};
export const labReceipt = {
  status: "completed",
  run_id: "public_run_1",
  best_model: "public-model-a",
  avg_score: 4.2,
  contract_applied: true,
  contract_pass: 1,
  model_count: 1,
  results: [
    {
      model: "public-model-a",
      score: 4.2,
      verdict: "pass",
      contract_pass: true,
      cost_krw: 0,
      latency_ms: 24,
      status: "ok",
    },
  ],
  history: [
    {
      id: "public_history_1",
      run_id: "public_run_1",
      best_model: "public-model-a",
      avg_score: 4.2,
      contract_pass: 1,
      model_count: 1,
      avg_cost_krw: 0,
      avg_latency_ms: 24,
      created_at: "2030-01-03T00:00:00Z",
    },
  ],
};
export const labContract = {
  id: "public_contract",
  name: "한글 JSON",
  type: "json",
  strict: true,
  schema_json: "{}",
  created_at: "2030-01-01T00:00:00Z",
};
