import { z } from "zod";
import type {
  GetAdminUiActionsSummaryData,
  GetAdminUiActionsSummaryResponse,
  PostAdminUiActionsEventsData,
  PostAdminUiActionsEventsResponse,
} from "@/shared/api/generated";
import { operation } from "@/shared/api/endpoint-factory";
import { uiTelemetryFeatureIdSchema } from "@/shared/api/domains/ui-telemetry";
import { actionKinds } from "@/shared/telemetry/action-channel";

const count = z.number().int().min(0).max(10_000);
const counts = z.object({ success: count, rejected: count, unknown: count }).strict();
const group = counts
  .extend({
    feature_id: uiTelemetryFeatureIdSchema,
    action: z.enum(actionKinds),
    ui_version: z
      .string()
      .regex(/^(?:v(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5}))?$/),
  })
  .strict()
  .refine((row) => row.success + row.rejected + row.unknown > 0);
export const uiActionsSummarySchema = counts
  .extend({
    enabled: z.boolean(),
    days: z.union([z.literal(7), z.literal(30)]),
    from: z.string().datetime(),
    to: z.string().datetime(),
    retention_days: z.literal(30),
    event_limit: z.literal(10_000),
    group_limit: z.literal(100),
    groups: z.array(group).max(100),
    other: counts,
  })
  .strict()
  .refine(
    (data) =>
      data.success + data.rejected + data.unknown <= 10_000 &&
      Date.parse(data.from) <= Date.parse(data.to) &&
      new Set(data.groups.map((row) => `${row.feature_id}|${row.action}|${row.ui_version}`)).size ===
        data.groups.length &&
      (["success", "rejected", "unknown"] as const).every(
        (outcome) =>
          data.groups.reduce((total, row) => total + row[outcome], data.other[outcome]) === data[outcome],
      ),
  ) satisfies z.ZodType<GetAdminUiActionsSummaryResponse>;
export type UIActionsSummary = z.infer<typeof uiActionsSummarySchema>;
export const uiActionsEndpoints = {
  events: operation<PostAdminUiActionsEventsData, PostAdminUiActionsEventsResponse>()(
    "POST",
    "/admin/ui-actions/events",
    z.undefined(),
  ),
  summary: operation<GetAdminUiActionsSummaryData, GetAdminUiActionsSummaryResponse>()(
    "GET",
    "/admin/ui-actions/summary",
    uiActionsSummarySchema,
    z.object({ days: z.union([z.literal(7), z.literal(30)]).optional() }).strict(),
  ),
} as const;
