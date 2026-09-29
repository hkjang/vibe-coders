import { z } from "zod";
import { migrationRegistry } from "@/config/migration-registry";

import type {
  GetAdminUiTelemetrySummaryData,
  GetAdminUiTelemetrySummaryResponse,
  PostAdminUiTelemetryEventsData,
  PostAdminUiTelemetryEventsResponse,
} from "@/shared/api/generated";
import { operation } from "@/shared/api/endpoint-factory";

export const uiTelemetryFeatureIdSchema = z.enum(migrationRegistry.map((feature) => feature.featureId));

const countSchema = z
  .object({
    feature_id: uiTelemetryFeatureIdSchema,
    visits: z.number().int().min(0).max(100_000),
    legacy_opens: z.number().int().min(0).max(100_000),
  })
  .refine((row) => row.legacy_opens <= row.visits);

export const uiTelemetrySummarySchema = z.object({
  enabled: z.boolean(),
  days: z.union([z.literal(7), z.literal(30)]),
  from: z.string().datetime(),
  to: z.string().datetime(),
  retention_days: z.literal(30),
  visit_limit: z.literal(100_000),
  features: z.array(countSchema).max(256),
}) satisfies z.ZodType<GetAdminUiTelemetrySummaryResponse>;

export const uiTelemetryEndpoints = {
  events: operation<PostAdminUiTelemetryEventsData, PostAdminUiTelemetryEventsResponse>()(
    "POST",
    "/admin/ui-telemetry/events",
    z.undefined(),
  ),
  summary: operation<GetAdminUiTelemetrySummaryData, GetAdminUiTelemetrySummaryResponse>()(
    "GET",
    "/admin/ui-telemetry/summary",
    uiTelemetrySummarySchema,
    z.object({ days: z.union([z.literal(7), z.literal(30)]).optional() }).strict(),
  ),
} as const;
