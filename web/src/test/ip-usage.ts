export const ipFixture = (ip = "2001:0db8::1", requests = 12) => ({
  ip,
  requests,
  tokens: 1200,
  cost_krw: 1500.25,
  average_latency_ms: 1200.5,
  last_seen: "2026-11-12T08:00:00Z",
  distinct_keys: 2,
});
export const ipDetailFixture = (ip = "2001:0db8::1") => ({
  stats: ipFixture(ip),
  daily: [{ date: "2026-11-12", bucket: "", requests: 12, tokens: 1200, cost_krw: 1500.25 }],
  by_model: Array.from({ length: 35 }, (_, index) => ({
    key: "모델-" + String(index + 1).padStart(2, "0"),
    requests: 35 - index,
    tokens: 100,
    cost_krw: 12.5,
    average_latency_ms: 25,
  })),
  by_key: [
    { key: "key_public_id", requests: 12, tokens: 1200, cost_krw: 1500.25, average_latency_ms: 1200.5 },
  ],
  by_language: [{ language: "ko", requests: 12, average_confidence: 0.875 }],
  recent: [
    {
      id: "req_public_ip",
      model: "공개 모델",
      status_code: 200,
      latency_ms: 1200.5,
      total_tokens: 100,
      estimated_cost: 125.25,
      created_at: "2026-11-12T08:00:00Z",
      prompts: [{ text: "PRIVATE_PROMPT_FIXTURE" }],
      error: "PRIVATE_ERROR_FIXTURE",
      forwarded_for: "PRIVATE_FORWARD_FIXTURE",
    },
  ],
});
