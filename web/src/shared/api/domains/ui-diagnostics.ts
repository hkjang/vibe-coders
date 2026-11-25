import { z } from "zod";
import type {
  GetAdminUiDiagnosticsSummaryData,
  GetAdminUiDiagnosticsSummaryResponse,
  PostAdminUiDiagnosticsEventsData,
  PostAdminUiDiagnosticsEventsResponse,
} from "@/shared/api/generated";
import { openApiOperations } from "@/shared/api/generated/paths.gen";
import { operation } from "@/shared/api/endpoint-factory";
import { uiTelemetryFeatureIdSchema } from "@/shared/api/domains/ui-telemetry";

const operations = new Set<string>(openApiOperations.map(({ method, path }) => `${method} ${path}`));
const count = z.number().int().min(0).max(10_000);
const fields = {
  feature_id: uiTelemetryFeatureIdSchema,
  kind: z.enum(["api_error", "js_error"]),
  ui_version: z.string().regex(/^(?:v(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5}))?$/),
  endpoint: z.string().max(256),
  method: z.enum(["", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
  status: z
    .number()
    .int()
    .refine((status) => status === 0 || (status >= 100 && status <= 599)),
  request_id: z.string().regex(/^(?:trace_[0-9a-f]{32})?$/),
  failure: z.enum([
    "http",
    "auth",
    "permission",
    "contract",
    "network",
    "timeout",
    "error",
    "type",
    "range",
    "reference",
    "syntax",
    "uri",
    "eval",
    "aggregate",
    "unknown",
  ]),
  boundary: z.enum(["", "root", "route"]),
};

const baseSchema = z.object(fields);

function validDiagnostic(row: z.infer<typeof baseSchema>): boolean {
  if (row.kind === "js_error")
    return (
      row.endpoint === "" &&
      row.method === "" &&
      row.status === 0 &&
      row.request_id === "" &&
      row.boundary !== "" &&
      ["error", "type", "range", "reference", "syntax", "uri", "eval", "aggregate", "unknown"].includes(
        row.failure,
      )
    );
  return (
    row.boundary === "" &&
    operations.has(`${row.method} ${row.endpoint}`) &&
    !row.endpoint.startsWith("/auth/") &&
    !row.endpoint.startsWith("/admin/ui-telemetry/") &&
    !row.endpoint.startsWith("/admin/ui-actions/") &&
    !row.endpoint.startsWith("/admin/ui-diagnostics/") &&
    ["http", "auth", "permission", "contract", "network", "timeout"].includes(row.failure) &&
    (row.failure !== "http" || row.status >= 400) &&
    (row.failure !== "auth" || row.status === 401) &&
    (row.failure !== "permission" || row.status === 403)
  );
}
const group = baseSchema
  .extend({ events: count.min(1) })
  .strict()
  .refine((row) => row.request_id === "" && validDiagnostic(row));
const recent = baseSchema.extend({ received_at: z.string().datetime() }).strict().refine(validDiagnostic);

export const uiDiagnosticsSummarySchema = z
  .object({
    enabled: z.boolean(),
    days: z.union([z.literal(7), z.literal(30)]),
    from: z.string().datetime(),
    to: z.string().datetime(),
    retention_days: z.literal(30),
    event_limit: z.literal(10_000),
    group_limit: z.literal(100),
    recent_limit: z.literal(20),
    total: count,
    other_group_events: count,
    groups: z.array(group).max(100),
    recent: z.array(recent).max(20),
  })
  .strict()
  .refine(
    (data) =>
      data.groups.reduce((total, row) => total + row.events, data.other_group_events) === data.total &&
      data.recent.length <= data.total,
  ) satisfies z.ZodType<GetAdminUiDiagnosticsSummaryResponse>;

export type UIDiagnosticsSummary = z.infer<typeof uiDiagnosticsSummarySchema>;
export const uiDiagnosticsEndpoints = {
  events: operation<PostAdminUiDiagnosticsEventsData, PostAdminUiDiagnosticsEventsResponse>()(
    "POST",
    "/admin/ui-diagnostics/events",
    z.undefined(),
  ),
  summary: operation<GetAdminUiDiagnosticsSummaryData, GetAdminUiDiagnosticsSummaryResponse>()(
    "GET",
    "/admin/ui-diagnostics/summary",
    uiDiagnosticsSummarySchema,
    z.object({ days: z.union([z.literal(7), z.literal(30)]).optional() }).strict(),
  ),
} as const;
