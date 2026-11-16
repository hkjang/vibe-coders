import type { McpOverviewResponse, Text2SqlSummaryResponse } from "../../src/shared/api/generated";

export const mcpSummary: McpOverviewResponse = {
  upstream_count: 3,
  enabled_upstream_count: 2,
  healthy_upstream_count: 1,
  total_tools: 514,
  total_prompts: 2,
  total_resources: 4,
  discovery_error_count: 1,
  blocked_count: 2,
  recent_call_count: 1234,
  recent_error_count: 6,
  recent_error_rate: 6 / 1234,
  since: "2026-11-16T01:00:00Z",
  generated_at: "2026-11-17T01:00:00Z",
  fetched_at: "2026-11-17T00:50:00Z",
  summary: { total_calls: 4567, total_errors: 9, distinct_tools: 514, mcp_servers: 3 },
};
export const text2sqlSummary: Text2SqlSummaryResponse = {
  enabled: true,
  window: "24h",
  since: "2026-11-16T01:00:00Z",
  generated_at: "2026-11-17T01:00:00Z",
  stats: { total: 100, valid: 95, executed: 82, errors: 3, cost_krw: 1200, valid_rate: 0.95 },
};
