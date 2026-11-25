import { AppError } from "@/shared/api/error";
import type { DwDateBounds, DwDateSelection } from "@/shared/utils/dw-date-bounds";
import { useInsightQuery, type InsightQuery } from "./use-insight-query";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { DwBucket, DwDimension, DwOrder, DwWindow } from "@/features/data/warehouse/warehouse-filters";
import { apiClient } from "@/shared/api/client";
import type {
  ClickhouseLag,
  ClickhouseOverview,
  DwConsistency,
  DwLatency,
  DwOverview,
  DwQuality,
  DwRouting,
  DwSinkStatus,
  DwText2Sql,
  ModelMigration,
  Savings,
} from "@/shared/api/domains/data.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";

const warehouse = endpoints.domains.data.warehouse;
const pipeline = endpoints.domains.data.pipeline;

export const dataQueryKeys = {
  warehouse: ["data", "warehouse"] as const,
  pipeline: ["data", "pipeline"] as const,
  metrics: ["data", "metrics"] as const,
  products: ["data", "products"] as const,
};

const topLimit = 10;

export interface InsightsQueries {
  overview: InsightQuery<DwOverview>;
  timeseries: InsightQuery<Awaited<ReturnType<typeof loadTimeseries>>>;
  dimensions: InsightQuery<Awaited<ReturnType<typeof loadDimensions>>>;
  latency: InsightQuery<DwLatency>;
  quality: InsightQuery<DwQuality>;
  routing: InsightQuery<DwRouting>;
  text2sql: InsightQuery<DwText2Sql>;
  savings: InsightQuery<Savings>;
  modelMigration: InsightQuery<ModelMigration>;
}

function loadTimeseries(range: DwWindow, bucket: DwBucket, signal: AbortSignal) {
  return apiClient.request(warehouse.timeseries, { query: { window: range, bucket }, signal });
}

async function loadDimensions(
  range: DwWindow,
  dimension: DwDimension,
  order: DwOrder,
  signal: AbortSignal,
  bounds?: DwDateBounds,
) {
  const response = await apiClient.request(warehouse.dimensions, {
    query: { window: range, dimension, order_by: order, limit: topLimit, ...bounds },
    signal,
  });
  if (
    bounds &&
    (!response.configured || response.since !== bounds.since_day || response.until !== bounds.until_day)
  )
    throw new AppError(
      "선택 기간과 서버 응답이 일치하지 않습니다. 새로고침하거나 전체 기간으로 돌아가세요.",
      { kind: "contract" },
    );
  return response;
}

/** Every panel of the DW insight tab; each keeps its own loading and error state. */
export function useInsightsQueries(
  range: DwWindow,
  bucket: DwBucket,
  dimension: DwDimension,
  order: DwOrder,
  selection: DwDateSelection,
): InsightsQueries {
  const overview = useInsightQuery({
    queryKey: [...dataQueryKeys.warehouse, "overview", range],
    queryFn: ({ signal }) => apiClient.request(warehouse.overview, { query: { window: range }, signal }),
  });
  const configured = overview.data?.configured === true;
  const timeseries = useInsightQuery({
    queryKey: [...dataQueryKeys.warehouse, "timeseries", range, bucket],
    queryFn: ({ signal }) => loadTimeseries(range, bucket, signal),
    enabled: configured,
  });
  const bounds = selection.kind === "selected" ? selection.bounds : undefined;
  const dimensionsEnabled =
    configured &&
    selection.kind !== "invalid" &&
    (!bounds || timeseries.data?.date_bounds_supported === true);
  const dimensions = useInsightQuery({
    queryKey: [...dataQueryKeys.warehouse, "dimensions", range, dimension, order, bounds, selection.kind],
    queryFn: ({ signal }) => loadDimensions(range, dimension, order, signal, bounds),
    enabled: dimensionsEnabled,
  });
  const latency = useInsightQuery({
    queryKey: [...dataQueryKeys.warehouse, "latency", range],
    queryFn: ({ signal }) => apiClient.request(warehouse.latency, { query: { window: range }, signal }),
    enabled: configured,
  });
  const quality = useInsightQuery({
    queryKey: [...dataQueryKeys.warehouse, "quality", range],
    queryFn: ({ signal }) => apiClient.request(warehouse.quality, { query: { window: range }, signal }),
    enabled: configured,
  });
  const routing = useInsightQuery({
    queryKey: [...dataQueryKeys.warehouse, "routing", range],
    queryFn: ({ signal }) => apiClient.request(warehouse.routing, { query: { window: range }, signal }),
    enabled: configured,
  });
  const text2sql = useInsightQuery({
    queryKey: [...dataQueryKeys.warehouse, "text2sql", range],
    queryFn: ({ signal }) => apiClient.request(warehouse.text2sql, { query: { window: range }, signal }),
    enabled: configured,
  });
  // Both read the operational database rather than ClickHouse, but the legacy dashboard
  // showed them here and only after the warehouse was configured, so the tab keeps that.
  const savings = useInsightQuery({
    queryKey: [...dataQueryKeys.warehouse, "savings", range, dimension],
    queryFn: ({ signal }) =>
      apiClient.request(warehouse.savings, {
        query: { window: range, dimension },
        signal,
      }),
    enabled: configured,
  });
  const modelMigration = useInsightQuery({
    queryKey: [...dataQueryKeys.warehouse, "model-migration", range],
    queryFn: ({ signal }) =>
      apiClient.request(warehouse.modelMigration, { query: { window: range }, signal }),
    enabled: configured,
  });
  return {
    overview,
    timeseries,
    dimensions,
    latency,
    quality,
    routing,
    text2sql,
    savings,
    modelMigration,
  };
}

export interface PipelineQueries {
  overview: UseQueryResult<ClickhouseOverview>;
  lag: UseQueryResult<ClickhouseLag>;
  sinkStatus: UseQueryResult<DwSinkStatus>;
  consistency: UseQueryResult<DwConsistency>;
}

export function usePipelineQueries(days: number): PipelineQueries {
  const refetchInterval = useRefreshInterval();
  const overview = useQuery({
    queryKey: [...dataQueryKeys.pipeline, "overview"],
    queryFn: ({ signal }) => apiClient.request(pipeline.clickhouseOverview, { signal }),
    refetchInterval,
  });
  const configured = overview.data?.configured === true;
  const lag = useQuery({
    queryKey: [...dataQueryKeys.pipeline, "lag"],
    queryFn: ({ signal }) => apiClient.request(pipeline.lag, { signal }),
    enabled: configured,
    refetchInterval,
  });
  const sinkStatus = useQuery({
    queryKey: [...dataQueryKeys.pipeline, "sink-status"],
    queryFn: ({ signal }) => apiClient.request(pipeline.sinkStatus, { signal }),
    refetchInterval,
  });
  const consistency = useQuery({
    queryKey: [...dataQueryKeys.pipeline, "consistency", days],
    queryFn: ({ signal }) => apiClient.request(pipeline.consistency, { query: { days }, signal }),
    enabled: configured,
  });
  return { overview, lag, sinkStatus, consistency };
}
