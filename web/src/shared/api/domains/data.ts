import { z } from "zod";

import type {
  DeleteAdminDataProductsData,
  GetAdminDataProductsCandidatesData,
  GetAdminDataProductsData,
  GetAdminDataProductsRequestsData,
  GetAdminDwClickhouseLagData,
  GetAdminDwClickhouseEventsData,
  GetAdminDwClickhouseOverviewData,
  GetAdminDwConsistencyData,
  GetAdminDwDashboardDimensionsData,
  GetAdminDwDashboardLatencyData,
  GetAdminDwDashboardOverviewData,
  GetAdminDwDashboardQualityData,
  GetAdminDwDashboardRoutingData,
  GetAdminDwDashboardText2SqlData,
  GetAdminDwDashboardTimeseriesData,
  GetAdminDwMetricsData,
  GetAdminDwSinkStatusData,
  PostAdminDataProductsData,
  PostAdminDataProductsRequestsData,
  PostAdminDwClickhouseBootstrapData,
  PostAdminDwClickhouseData,
  PostAdminDwDashboardRefreshData,
  PostAdminDwMetricsData,
  PostAdminDwSinkRetryData,
  PostAdminSettingsTestClickhouseData,
} from "@/shared/api/generated";
import { operation, type OperationData, type WithQuery } from "@/shared/api/endpoint-factory";
import {
  clickhouseBootstrapSchema,
  clickhouseEventsSchema,
  clickhouseLagSchema,
  clickhouseOverviewSchema,
  clickhouseTestSchema,
  dataProductCandidateListSchema,
  dataProductDecisionSchema,
  dataProductDeleteSchema,
  dataProductListSchema,
  dataProductRequestListSchema,
  dataProductUpsertSchema,
  dwConsistencySchema,
  dwDimensionsSchema,
  dwLatencySchema,
  dwOverviewSchema,
  dwQualitySchema,
  dwRefreshSchema,
  dwRoutingSchema,
  dwSinkResultSchema,
  dwSinkRetryResultSchema,
  dwSinkStatusSchema,
  dwText2SqlSchema,
  dwTimeseriesSchema,
  metricListSchema,
  metricUpsertSchema,
} from "@/shared/api/domains/data.schemas";

/**
 * Replaces the generated (always `never`) body of a legacy operation with the
 * request body the Go handler decodes. Mirrors `WithQuery` for request payloads.
 */
type WithBody<Data extends OperationData, Body extends object> = Omit<Data, "body"> & {
  readonly body: Body;
};

/** Legacy admin paths are documented without a response schema; zod is the contract. */
type LegacyResponse = unknown;

const windowQuerySchema = z.object({ window: z.string() });
const dimensionQuerySchema = z.object({
  window: z.string(),
  dimension: z.string(),
  order_by: z.string(),
  limit: z.number().int().positive(),
});
const timeseriesQuerySchema = z.object({ window: z.string(), bucket: z.string() });
const daysQuerySchema = z.object({ days: z.number().int().positive() });
const eventsQuerySchema = z.object({ table: z.string(), limit: z.number().int().positive() });
const productListQuerySchema = z.object({ status: z.string().optional() });
const productRequestQuerySchema = z.object({ product: z.string().optional() });
const candidateQuerySchema = z.object({
  window: z.string(),
  min_count: z.number().int().positive(),
});
const idQuerySchema = z.object({ id: z.string() });

/** Body of `POST /admin/dw/metrics` (see `handleAdminMetrics`). */
export interface MetricCatalogBody {
  readonly metric_key: string;
  readonly name_ko: string;
  readonly description: string;
  readonly query_template: string;
  readonly dimensions: readonly string[];
  readonly owner: string;
  readonly sensitivity: string;
  readonly enabled: boolean;
}

/** Body of `POST /admin/data-products` (see `handleAdminDataProducts`). */
export interface DataProductBody {
  readonly id?: string;
  readonly product_key: string;
  readonly name_ko: string;
  readonly description: string;
  readonly source_type: string;
  readonly source_ref: string;
  readonly owner: string;
  readonly allowed_teams: readonly string[];
  readonly sensitivity: string;
  readonly status: string;
}

export interface DataProductDecisionBody {
  readonly id: string;
  readonly action: "approve" | "deny";
}

/**
 * ClickHouse connection overrides for the connection test. Values are typed here so
 * the screen can send an operator-entered password without ever storing it; the
 * screen keeps these fields write-only.
 */
export interface ClickhouseTestBody {
  readonly url?: string;
  readonly user?: string;
  readonly password?: string;
  readonly database?: string;
  readonly table?: string;
}

// data domain endpoints. Declare every server call this domain's screens make
// here with `operation()` from "@/shared/api/endpoint-factory" and a zod schema
// (see "@/shared/api/loose" for legacy responses without a documented shape).
export const dataEndpoints = {
  warehouse: {
    overview: operation<WithQuery<GetAdminDwDashboardOverviewData, { window: string }>, LegacyResponse>()(
      "GET",
      "/admin/dw/dashboard/overview",
      dwOverviewSchema,
      windowQuerySchema,
    ),
    timeseries: operation<
      WithQuery<GetAdminDwDashboardTimeseriesData, { window: string; bucket: string }>,
      LegacyResponse
    >()("GET", "/admin/dw/dashboard/timeseries", dwTimeseriesSchema, timeseriesQuerySchema),
    dimensions: operation<
      WithQuery<
        GetAdminDwDashboardDimensionsData,
        { window: string; dimension: string; order_by: string; limit: number }
      >,
      LegacyResponse
    >()("GET", "/admin/dw/dashboard/dimensions", dwDimensionsSchema, dimensionQuerySchema),
    text2sql: operation<WithQuery<GetAdminDwDashboardText2SqlData, { window: string }>, LegacyResponse>()(
      "GET",
      "/admin/dw/dashboard/text2sql",
      dwText2SqlSchema,
      windowQuerySchema,
    ),
    routing: operation<WithQuery<GetAdminDwDashboardRoutingData, { window: string }>, LegacyResponse>()(
      "GET",
      "/admin/dw/dashboard/routing",
      dwRoutingSchema,
      windowQuerySchema,
    ),
    latency: operation<WithQuery<GetAdminDwDashboardLatencyData, { window: string }>, LegacyResponse>()(
      "GET",
      "/admin/dw/dashboard/latency",
      dwLatencySchema,
      windowQuerySchema,
    ),
    quality: operation<WithQuery<GetAdminDwDashboardQualityData, { window: string }>, LegacyResponse>()(
      "GET",
      "/admin/dw/dashboard/quality",
      dwQualitySchema,
      windowQuerySchema,
    ),
    refreshCache: operation<PostAdminDwDashboardRefreshData, LegacyResponse>()(
      "POST",
      "/admin/dw/dashboard/refresh",
      dwRefreshSchema,
    ),
  },
  pipeline: {
    sinkStatus: operation<GetAdminDwSinkStatusData, LegacyResponse>()(
      "GET",
      "/admin/dw/sink-status",
      dwSinkStatusSchema,
    ),
    sinkRetry: operation<PostAdminDwSinkRetryData, LegacyResponse>()(
      "POST",
      "/admin/dw/sink-retry",
      dwSinkRetryResultSchema,
    ),
    consistency: operation<WithQuery<GetAdminDwConsistencyData, { days: number }>, LegacyResponse>()(
      "GET",
      "/admin/dw/consistency",
      dwConsistencySchema,
      daysQuerySchema,
    ),
    clickhouseOverview: operation<GetAdminDwClickhouseOverviewData, LegacyResponse>()(
      "GET",
      "/admin/dw/clickhouse/overview",
      clickhouseOverviewSchema,
    ),
    lag: operation<GetAdminDwClickhouseLagData, LegacyResponse>()(
      "GET",
      "/admin/dw/clickhouse/lag",
      clickhouseLagSchema,
    ),
    events: operation<
      WithQuery<GetAdminDwClickhouseEventsData, { table: string; limit: number }>,
      LegacyResponse
    >()("GET", "/admin/dw/clickhouse/events", clickhouseEventsSchema, eventsQuerySchema),
    runSink: operation<WithQuery<PostAdminDwClickhouseData, { days: number }>, LegacyResponse>()(
      "POST",
      "/admin/dw/clickhouse",
      dwSinkResultSchema,
      daysQuerySchema,
    ),
    bootstrap: operation<PostAdminDwClickhouseBootstrapData, LegacyResponse>()(
      "POST",
      "/admin/dw/clickhouse/bootstrap",
      clickhouseBootstrapSchema,
    ),
    testConnection: operation<
      WithBody<PostAdminSettingsTestClickhouseData, ClickhouseTestBody>,
      LegacyResponse
    >()("POST", "/admin/settings/test/clickhouse", clickhouseTestSchema),
  },
  metrics: {
    list: operation<GetAdminDwMetricsData, LegacyResponse>()("GET", "/admin/dw/metrics", metricListSchema),
    upsert: operation<WithBody<PostAdminDwMetricsData, MetricCatalogBody>, LegacyResponse>()(
      "POST",
      "/admin/dw/metrics",
      metricUpsertSchema,
    ),
  },
  products: {
    list: operation<WithQuery<GetAdminDataProductsData, { status?: string }>, LegacyResponse>()(
      "GET",
      "/admin/data-products",
      dataProductListSchema,
      productListQuerySchema,
    ),
    upsert: operation<WithBody<PostAdminDataProductsData, DataProductBody>, LegacyResponse>()(
      "POST",
      "/admin/data-products",
      dataProductUpsertSchema,
    ),
    remove: operation<WithQuery<DeleteAdminDataProductsData, { id: string }>, LegacyResponse>()(
      "DELETE",
      "/admin/data-products",
      dataProductDeleteSchema,
      idQuerySchema,
    ),
    candidates: operation<
      WithQuery<GetAdminDataProductsCandidatesData, { window: string; min_count: number }>,
      LegacyResponse
    >()("GET", "/admin/data-products/candidates", dataProductCandidateListSchema, candidateQuerySchema),
    requests: operation<WithQuery<GetAdminDataProductsRequestsData, { product?: string }>, LegacyResponse>()(
      "GET",
      "/admin/data-products/requests",
      dataProductRequestListSchema,
      productRequestQuerySchema,
    ),
    decide: operation<WithBody<PostAdminDataProductsRequestsData, DataProductDecisionBody>, LegacyResponse>()(
      "POST",
      "/admin/data-products/requests",
      dataProductDecisionSchema,
    ),
  },
} as const;
