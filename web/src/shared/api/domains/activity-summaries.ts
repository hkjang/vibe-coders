import { z } from "zod";
import type {
  AlertActivityResponse,
  AuditActivityResponse,
  IncidentActivityResponse,
  GetAdminAlertsSummaryData,
  GetAdminAuditLogsSummaryData,
  GetAdminIncidentsSummaryData,
} from "@/shared/api/generated";
import { operation } from "@/shared/api/endpoint-factory";

const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const window = z.enum(["1h", "24h", "7d", "30d"]);
const period = { window, since: timestamp, generated_at: timestamp };
const query = z.strictObject({ window });
export const auditActivitySchema = z.strictObject({
  ...period,
  has_more: z.boolean(),
  changes: z
    .array(
      z.strictObject({
        category: z.enum([
          "provider",
          "model",
          "routing",
          "policy",
          "alert",
          "access",
          "mcp",
          "text2sql",
          "settings",
          "cost",
          "other",
        ]),
        operation: z.enum([
          "create",
          "update",
          "delete",
          "enable",
          "disable",
          "revoke",
          "rotate",
          "approve",
          "reject",
          "import",
          "rollback",
          "test",
          "other",
        ]),
        created_at: timestamp,
      }),
    )
    .max(5),
}) satisfies z.ZodType<AuditActivityResponse>;
export const alertActivitySchema = z.strictObject({
  ...period,
  has_more: z.boolean(),
  events: z
    .array(
      z.strictObject({
        metric: z.enum([
          "anomaly_zmax",
          "budget_burn_ratio",
          "errors",
          "failover_rate",
          "failovers",
          "first_chunk_p95_ms",
          "krw",
          "latency_p95_ms",
          "llm_eval_failure_rate",
          "llm_eval_failures",
          "mcp_new_tools",
          "other",
          "requests",
          "tokens",
          "tool_error_rate",
          "tool_errors",
          "tool_loop",
        ]),
        value: z.number(),
        threshold: z.number(),
        delivered: z.boolean(),
        delivery_failed: z.boolean(),
        created_at: timestamp,
      }),
    )
    .max(5),
}) satisfies z.ZodType<AlertActivityResponse>;
export const incidentActivitySchema = z.strictObject({
  ...period,
  total: count,
  current_hour: count,
  min_events: z.literal(5),
  signals: z
    .array(
      z.strictObject({
        provider: z.string(),
        started_at: timestamp,
        ended_at: timestamp,
        failovers: count,
        errors_5xx: count,
        requests: count,
        current_hour: z.boolean(),
      }),
    )
    .max(5),
}) satisfies z.ZodType<IncidentActivityResponse>;

export const activitySummaryEndpoints = {
  alerts: operation<GetAdminAlertsSummaryData, AlertActivityResponse>()(
    "GET",
    "/admin/alerts/summary",
    alertActivitySchema,
    query,
  ),
  audit: operation<GetAdminAuditLogsSummaryData, AuditActivityResponse>()(
    "GET",
    "/admin/audit-logs/summary",
    auditActivitySchema,
    query,
  ),
  incidents: operation<GetAdminIncidentsSummaryData, IncidentActivityResponse>()(
    "GET",
    "/admin/incidents/summary",
    incidentActivitySchema,
    query,
  ),
};
