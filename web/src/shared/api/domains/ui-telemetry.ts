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

const count = z.number().int().min(0).max(100_000);
const loadFields = {
  load_samples: count.optional(),
  load_total_ms: z.number().int().min(0).max(12_000_000_000).optional(),
  load_max_ms: z.number().int().min(0).max(120_000).optional(),
};

interface LoadCount {
  visits: number;
  load_samples?: number;
  load_total_ms?: number;
  load_max_ms?: number;
}

function validLoad(row: LoadCount): boolean {
  const { load_samples: samples, load_total_ms: total, load_max_ms: max } = row;
  if (samples === undefined && total === undefined && max === undefined) return true;
  return (
    samples !== undefined &&
    total !== undefined &&
    max !== undefined &&
    samples <= row.visits &&
    max <= total &&
    total <= samples * max &&
    (samples > 0 || (max === 0 && total === 0))
  );
}

const countSchema = z
  .object({
    feature_id: uiTelemetryFeatureIdSchema,
    visits: z.number().int().min(0).max(100_000),
    legacy_opens: z.number().int().min(0).max(100_000),
    ...loadFields,
  })
  .refine((row) => row.legacy_opens <= row.visits && validLoad(row));

const versionSchema = z
  .object({
    ui_version: z
      .string()
      .regex(/^(?:v(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5}))?$/),
    visits: count,
    load_samples: loadFields.load_samples.unwrap(),
    load_total_ms: loadFields.load_total_ms.unwrap(),
    load_max_ms: loadFields.load_max_ms.unwrap(),
  })
  .refine(validLoad);

export const uiTelemetrySummarySchema = z
  .object({
    enabled: z.boolean(),
    days: z.union([z.literal(7), z.literal(30)]),
    from: z.string().datetime(),
    to: z.string().datetime(),
    retention_days: z.literal(30),
    visit_limit: z.literal(100_000),
    features: z.array(countSchema).max(256),
    load_metrics_available: z.boolean().optional(),
    load_limit_ms: z.literal(120_000).optional(),
    version_limit: z.literal(20).optional(),
    versions: z.array(versionSchema).max(20).optional(),
    other_version_visits: count.optional(),
  })
  .refine((data) => {
    const total = data.features.reduce((sum, row) => sum + row.visits, 0);
    if (total > 100_000 || new Set(data.features.map((row) => row.feature_id)).size !== data.features.length)
      return false;
    if (!data.load_metrics_available) return true;
    if (
      !data.versions ||
      data.load_limit_ms !== 120_000 ||
      data.version_limit !== 20 ||
      data.other_version_visits === undefined ||
      data.features.some((row) => row.load_samples === undefined)
    )
      return false;
    return (
      new Set(data.versions.map((row) => row.ui_version)).size === data.versions.length &&
      data.versions.reduce((sum, row) => sum + row.visits, data.other_version_visits) === total &&
      data.versions.reduce((sum, row) => sum + row.load_samples, 0) <=
        data.features.reduce((sum, row) => sum + (row.load_samples ?? 0), 0)
    );
  }) satisfies z.ZodType<GetAdminUiTelemetrySummaryResponse>;

export type UITelemetrySummary = z.infer<typeof uiTelemetrySummarySchema>;

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
