import { z } from "zod";

import { operation, type WithQuery } from "@/shared/api/endpoint-factory";
import type {
  GetAdminRoutingLearningData,
  GetAdminRoutingLearningResponse,
  RoutingLearningReport as GeneratedRoutingLearningReport,
} from "@/shared/api/generated";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const measurement = z.number().finite();

export const routingLearningCellSchema = z.object({
  task_type: z.string(),
  bucket: z.string(),
  model: z.string(),
  requests: count,
  successes: count,
  success_rate: measurement,
  fallback_rate: measurement,
  avg_cost_krw: measurement,
  avg_latency_ms: measurement,
  thumbs_up: count,
  thumbs_down: count,
});

export const routingLearningRecommendationSchema = z.object({
  task_type: z.string(),
  // Keep unknown buckets visible; the reviewed creation flow rejects them
  // instead of silently broadening their conditions to all complexities.
  bucket: z.string(),
  recommended_model: z.string(),
  success_rate: measurement,
  avg_cost_krw: measurement,
  samples: count,
  top_model: z.string(),
  top_success_rate: measurement,
  differs: z.boolean(),
  confident: z.boolean(),
  rationale: z.string(),
});

/** No coercion/defaults/trimming: a review must use the report actually received. */
export const routingLearningReportSchema = z.object({
  since: z.iso.datetime({ offset: true }),
  min_samples: count.positive(),
  cells: z.array(routingLearningCellSchema),
  recommendations: z.array(routingLearningRecommendationSchema),
}) satisfies z.ZodType<GeneratedRoutingLearningReport>;

// This screen supports four periods; the existing server also accepts other
// positive Go duration strings. This adapter does not change that server API.
export const routingLearningQuerySchema = z.object({
  window: z.enum(["24h", "7d", "30d", "90d"]),
});
export type RoutingLearningQuery = z.input<typeof routingLearningQuerySchema>;
export type RoutingLearningReport = z.output<typeof routingLearningReportSchema>;
export type RoutingLearningRecommendation = z.output<typeof routingLearningRecommendationSchema>;

export const routingLearningEndpoints = {
  report: operation<
    WithQuery<GetAdminRoutingLearningData, RoutingLearningQuery>,
    GetAdminRoutingLearningResponse
  >()("GET", "/admin/routing/learning", routingLearningReportSchema, routingLearningQuerySchema),
} as const;
