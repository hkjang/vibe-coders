import { z } from "zod";

import { operation } from "@/shared/api/endpoint-factory";
import type {
  DeleteAdminRoutingDynamicRoutesIdData,
  DeleteAdminRoutingDynamicRoutesIdResponse,
  GetAdminRoutingDynamicRoutesData,
  GetAdminRoutingDynamicRoutesIdActivityData,
  GetAdminRoutingDynamicRoutesIdActivityResponse,
  GetAdminRoutingDynamicRoutesIdData,
  GetAdminRoutingDynamicRoutesIdResponse,
  GetAdminRoutingDynamicRoutesIdVersionsVersionData,
  GetAdminRoutingDynamicRoutesIdVersionsVersionResponse,
  GetAdminRoutingDynamicRoutesResponse,
  PatchAdminRoutingDynamicRoutesIdData,
  PatchAdminRoutingDynamicRoutesIdResponse,
  PostAdminRoutingDynamicRoutesData,
  PostAdminRoutingDynamicRoutesIdDeployData,
  PostAdminRoutingDynamicRoutesIdDeployResponse,
  PostAdminRoutingDynamicRoutesIdVersionsData,
  PostAdminRoutingDynamicRoutesIdVersionsResponse,
  PostAdminRoutingDynamicRoutesResponse,
  PostAdminRoutingDynamicRoutesSimulateData,
  PostAdminRoutingDynamicRoutesSimulateResponse,
  PostAdminRoutingDynamicRoutesValidateData,
  PostAdminRoutingDynamicRoutesValidateResponse,
} from "@/shared/api/generated";
import { orDefault } from "@/shared/api/loose";

const text = orDefault(z.string(), "");
const count = orDefault(z.number(), 0);

export const dynamicRouteElementTypes = [
  "start",
  "conditional",
  "percentage",
  "rate",
  "model",
  "end",
] as const;
export type DynamicRouteElementType = (typeof dynamicRouteElementTypes)[number];

const propertiesSchema = z.looseObject({
  conditions: z.record(z.string(), z.unknown()).optional(),
  stickyKey: z.string().optional(),
  limitType: z.enum(["count", "cost"]).optional(),
  key: z.string().optional(),
  limit: z.number().optional(),
  window: z.number().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  timeout: z.number().optional(),
  retries: z.number().optional(),
  retryDelay: z.number().optional(),
  backoff: z.enum(["constant", "linear", "exponential"]).optional(),
});

export const dynamicRouteElementSchema = z.looseObject({
  id: z.string(),
  type: z.enum(dynamicRouteElementTypes),
  label: z.string().optional(),
  properties: orDefault(propertiesSchema, {}),
  outputs: z.record(z.string(), z.object({ elementId: z.string() })).optional(),
});
export type DynamicRouteElement = z.output<typeof dynamicRouteElementSchema>;

export const dynamicRouteGraphSchema = z.looseObject({
  elements: z.array(dynamicRouteElementSchema),
});
export type DynamicRouteGraph = z.output<typeof dynamicRouteGraphSchema>;

const issueSchema = z.object({ element_id: z.string().optional(), code: z.string(), message: z.string() });
export type DynamicRouteIssue = z.output<typeof issueSchema>;

export const dynamicRouteValidationSchema = z.object({
  errors: orDefault(z.array(issueSchema), []),
  warnings: orDefault(z.array(issueSchema), []),
});
export type DynamicRouteValidation = z.output<typeof dynamicRouteValidationSchema>;

export const dynamicRouteStates = ["live", "live_with_draft", "not_deployed", "disabled"] as const;

export const dynamicRouteSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: text,
  enabled: z.boolean(),
  deployed_version: count,
  latest_version: count,
  deployed_at: text,
  deployed_by: text,
  created_by: text,
  updated_by: text,
  created_at: text,
  updated_at: text,
  call_model: z.string(),
  state: z.enum(dynamicRouteStates),
  traffic_24h: orDefault(z.object({ requests: count, failures: count, fallbacks: count }), {
    requests: 0,
    failures: 0,
    fallbacks: 0,
  }),
});
export type DynamicRoute = z.output<typeof dynamicRouteSchema>;

const fieldSchema = z.object({ field: z.string(), description: z.string() });
export type DynamicRouteField = z.output<typeof fieldSchema>;

export const dynamicRouteVersionSchema = z.looseObject({
  route_id: z.string(),
  version: z.number(),
  note: text,
  created_by: text,
  created_at: text,
  graph: dynamicRouteGraphSchema.optional(),
  validation: dynamicRouteValidationSchema.optional(),
});
export type DynamicRouteVersion = z.output<typeof dynamicRouteVersionSchema>;

const listSchema = z.looseObject({
  routes: z.array(dynamicRouteSchema),
  count: count,
  fields: orDefault(z.array(fieldSchema), []),
});

const detailSchema = z.looseObject({
  route: dynamicRouteSchema,
  versions: orDefault(z.array(dynamicRouteVersionSchema), []),
  latest: dynamicRouteVersionSchema.optional(),
  deployed: dynamicRouteVersionSchema.optional(),
  fields: orDefault(z.array(fieldSchema), []),
});
export type DynamicRouteDetail = z.output<typeof detailSchema>;

const writeSchema = z.looseObject({
  route: dynamicRouteSchema,
  graph: dynamicRouteGraphSchema.optional(),
  version: dynamicRouteVersionSchema.optional(),
  validation: dynamicRouteValidationSchema,
});

const routeOnlySchema = z.looseObject({ route: dynamicRouteSchema });

export const dynamicRouteStepSchema = z.object({
  id: z.string(),
  type: z.enum(dynamicRouteElementTypes),
  outcome: z.string(),
  detail: z.string().optional(),
});
export type DynamicRouteStep = z.output<typeof dynamicRouteStepSchema>;

const outcome = z.enum(["success", "cache_hit", "failed", "rate_limited", "no_model"]);
export type DynamicRouteOutcome = z.output<typeof outcome>;

const activitySchema = z.looseObject({
  route: dynamicRouteSchema,
  hours: count,
  traffic: orDefault(
    z.array(
      z.looseObject({
        version: count,
        final_element_id: text,
        final_model: text,
        outcome: text,
        requests: count,
        fallbacks: count,
        avg_latency_ms: count,
        cost_krw: count,
      }),
    ),
    [],
  ),
  limits: orDefault(
    z.array(
      z.looseObject({
        element_id: z.string(),
        scoped: z.boolean(),
        window_start: text,
        window_end: text,
        request_count: count,
        cost_krw: count,
      }),
    ),
    [],
  ),
  requests: orDefault(
    z.array(
      z.looseObject({
        request_id: z.string(),
        route_id: z.string(),
        route_name: z.string(),
        version: count,
        final_element_id: text,
        final_model: text,
        final_provider: text,
        provider_ref: text,
        fallbacks: count,
        attempts: count,
        outcome: outcome,
        status_code: count,
        latency_ms: count,
        cost_krw: count,
        created_at: text,
        steps: orDefault(z.array(dynamicRouteStepSchema), []),
        metadata: orDefault(z.record(z.string(), z.unknown()), {}),
      }),
    ),
    [],
  ),
});
export type DynamicRouteActivity = z.output<typeof activitySchema>;

const validateSchema = z.looseObject({
  valid: z.boolean(),
  graph: dynamicRouteGraphSchema,
  validation: dynamicRouteValidationSchema,
});

export const dynamicRouteSimulationSchema = z.looseObject({
  steps: orDefault(z.array(dynamicRouteStepSchema), []),
  path: text,
  outcome: outcome,
  final_element_id: text,
  final_model: text,
  provider: text,
  attempts: count,
  fallbacks: count,
  blocked_by: text,
  retry_after_seconds: count,
});
export type DynamicRouteSimulation = z.output<typeof dynamicRouteSimulationSchema>;

const simulateSchema = z.looseObject({
  result: dynamicRouteSimulationSchema,
  distribution: orDefault(
    z.array(
      z.looseObject({
        final_element_id: text,
        final_model: text,
        outcome: outcome,
        count: count,
        share: count,
      }),
    ),
    [],
  ),
  samples: count,
  validation: dynamicRouteValidationSchema,
});
export type DynamicRouteSimulateResult = z.output<typeof simulateSchema>;

const deleteSchema = z.looseObject({ id: z.string(), status: z.literal("deleted") });

/** How far back the traffic view looks, in hours (the server caps it at 31 days). */
export const activityQuerySchema = z.object({ hours: z.number().int().min(1).max(744).optional() }).strict();

/** The rejection body of a graph with errors: the per-element validation rides on it. */
export const dynamicRouteRejectionSchema = z.looseObject({ validation: dynamicRouteValidationSchema });

export const routingDynamicEndpoints = {
  list: operation<GetAdminRoutingDynamicRoutesData, GetAdminRoutingDynamicRoutesResponse>()(
    "GET",
    "/admin/routing/dynamic-routes",
    listSchema,
  ),
  create: operation<PostAdminRoutingDynamicRoutesData, PostAdminRoutingDynamicRoutesResponse>()(
    "POST",
    "/admin/routing/dynamic-routes",
    writeSchema,
  ),
  validate: operation<
    PostAdminRoutingDynamicRoutesValidateData,
    PostAdminRoutingDynamicRoutesValidateResponse
  >()("POST", "/admin/routing/dynamic-routes/validate", validateSchema),
  simulate: operation<
    PostAdminRoutingDynamicRoutesSimulateData,
    PostAdminRoutingDynamicRoutesSimulateResponse
  >()("POST", "/admin/routing/dynamic-routes/simulate", simulateSchema),
  detail: operation<GetAdminRoutingDynamicRoutesIdData, GetAdminRoutingDynamicRoutesIdResponse>()(
    "GET",
    "/admin/routing/dynamic-routes/{id}",
    detailSchema,
  ),
  update: operation<PatchAdminRoutingDynamicRoutesIdData, PatchAdminRoutingDynamicRoutesIdResponse>()(
    "PATCH",
    "/admin/routing/dynamic-routes/{id}",
    routeOnlySchema,
  ),
  remove: operation<DeleteAdminRoutingDynamicRoutesIdData, DeleteAdminRoutingDynamicRoutesIdResponse>()(
    "DELETE",
    "/admin/routing/dynamic-routes/{id}",
    deleteSchema,
  ),
  saveVersion: operation<
    PostAdminRoutingDynamicRoutesIdVersionsData,
    PostAdminRoutingDynamicRoutesIdVersionsResponse
  >()("POST", "/admin/routing/dynamic-routes/{id}/versions", writeSchema),
  version: operation<
    GetAdminRoutingDynamicRoutesIdVersionsVersionData,
    GetAdminRoutingDynamicRoutesIdVersionsVersionResponse
  >()(
    "GET",
    "/admin/routing/dynamic-routes/{id}/versions/{version}",
    z.looseObject({ version: dynamicRouteVersionSchema }),
  ),
  deploy: operation<
    PostAdminRoutingDynamicRoutesIdDeployData,
    PostAdminRoutingDynamicRoutesIdDeployResponse
  >()("POST", "/admin/routing/dynamic-routes/{id}/deploy", routeOnlySchema),
  activity: operation<
    GetAdminRoutingDynamicRoutesIdActivityData,
    GetAdminRoutingDynamicRoutesIdActivityResponse
  >()("GET", "/admin/routing/dynamic-routes/{id}/activity", activitySchema, activityQuerySchema),
} as const;
