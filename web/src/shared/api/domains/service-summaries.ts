import { z } from "zod";
import type {
  GetAdminMcpOverviewData,
  GetAdminText2SqlSummaryData,
  McpOverviewResponse,
  Text2SqlSummaryResponse,
} from "@/shared/api/generated";
import { operation } from "@/shared/api/endpoint-factory";

const count = z.number().int().nonnegative();
const timestamp = z.iso.datetime({ offset: true });
export const mcpServiceSummarySchema = z.strictObject({
  upstream_count: count,
  enabled_upstream_count: count,
  healthy_upstream_count: count,
  total_tools: count,
  total_prompts: count,
  total_resources: count,
  discovery_error_count: count,
  blocked_count: count,
  recent_call_count: count,
  recent_error_count: count,
  recent_error_rate: z.number().nonnegative(),
  since: timestamp,
  generated_at: timestamp,
  fetched_at: timestamp,
  summary: z.strictObject({
    total_calls: count,
    total_errors: count,
    distinct_tools: count,
    mcp_servers: count,
  }),
}) satisfies z.ZodType<McpOverviewResponse>;

export const text2sqlServiceSummarySchema = z.strictObject({
  enabled: z.boolean(),
  window: z.enum(["1h", "24h", "7d", "30d"]),
  since: timestamp,
  generated_at: timestamp,
  stats: z.strictObject({
    total: count,
    valid: count,
    executed: count,
    errors: count,
    cost_krw: z.number().nonnegative(),
    valid_rate: z.number().min(0).max(1),
  }),
}) satisfies z.ZodType<Text2SqlSummaryResponse>;

export const serviceSummaryEndpoints = {
  mcp: operation<GetAdminMcpOverviewData, McpOverviewResponse>()(
    "GET",
    "/admin/mcp/overview",
    mcpServiceSummarySchema,
  ),
  text2sql: operation<GetAdminText2SqlSummaryData, Text2SqlSummaryResponse>()(
    "GET",
    "/admin/text2sql/summary",
    text2sqlServiceSummarySchema,
    z.strictObject({ window: z.enum(["1h", "24h", "7d", "30d"]) }),
  ),
};
