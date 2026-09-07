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
  overview: UseQueryResult<DwOverview>;
  timeseries: UseQueryResult<Awaited<ReturnType<typeof loadTimeseries>>>;
  dimensions: UseQueryResult<Awaited<ReturnType<typeof loadDimensions>>>;
  latency: UseQueryResult<DwLatency>;
  quality: UseQueryResult<DwQuality>;
  routing: UseQueryResult<DwRouting>;
  text2sql: UseQueryResult<DwText2Sql>;
}

function loadTimeseries(range: DwWindow, bucket: DwBucket, signal: AbortSignal) {
  return apiClient.request(warehouse.timeseries, { query: { window: range, bucket }, signal });
}

function loadDimensions(range: DwWindow, dimension: DwDimension, order: DwOrder, signal: AbortSignal) {
  return apiClient.request(warehouse.dimensions, {
    query: { window: range, dimension, order_by: order, limit: topLimit },
    signal,
  });
}

/** Every panel of the DW insight tab; each keeps its own loading and error state. */
export function useInsightsQueries(
  range: DwWindow,
  bucket: DwBucket,
  dimension: DwDimension,
  order: DwOrder,
): InsightsQueries {
  const refetchInterval = useRefreshInterval();
  const overview = useQuery({
    queryKey: [...dataQueryKeys.warehouse, "overview", range],
    queryFn: ({ signal }) => apiClient.request(warehouse.overview, { query: { window: range }, signal }),
    refetchInterval,
  });
  const configured = overview.data?.configured === true;
  const timeseries = useQuery({
    queryKey: [...dataQueryKeys.warehouse, "timeseries", range, bucket],
    queryFn: ({ signal }) => loadTimeseries(range, bucket, signal),
    enabled: configured,
    refetchInterval,
  });
  const dimensions = useQuery({
    queryKey: [...dataQueryKeys.warehouse, "dimensions", range, dimension, order],
    queryFn: ({ signal }) => loadDimensions(range, dimension, order, signal),
    enabled: configured,
    refetchInterval,
  });
  const latency = useQuery({
    queryKey: [...dataQueryKeys.warehouse, "latency", range],
    queryFn: ({ signal }) => apiClient.request(warehouse.latency, { query: { window: range }, signal }),
    enabled: configured,
    refetchInterval,
  });
  const quality = useQuery({
    queryKey: [...dataQueryKeys.warehouse, "quality", range],
    queryFn: ({ signal }) => apiClient.request(warehouse.quality, { query: { window: range }, signal }),
    enabled: configured,
    refetchInterval,
  });
  const routing = useQuery({
    queryKey: [...dataQueryKeys.warehouse, "routing", range],
    queryFn: ({ signal }) => apiClient.request(warehouse.routing, { query: { window: range }, signal }),
    enabled: configured,
    refetchInterval,
  });
  const text2sql = useQuery({
    queryKey: [...dataQueryKeys.warehouse, "text2sql", range],
    queryFn: ({ signal }) => apiClient.request(warehouse.text2sql, { query: { window: range }, signal }),
    enabled: configured,
    refetchInterval,
  });
  return { overview, timeseries, dimensions, latency, quality, routing, text2sql };
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
