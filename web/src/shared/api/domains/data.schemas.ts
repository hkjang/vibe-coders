import { z } from "zod";

import { looseList, looseObject, numberish, orDefault, unknownRecord } from "@/shared/api/loose";

// Response contracts for the data domain (DW dashboard, ClickHouse pipeline, metric
// catalog, data products). The legacy admin API documents these paths without a
// response schema, so the shapes below are read from the Go handlers
// (`internal/proxy/dw_dashboard.go`, `clickhouse_sink.go`, `clickhouse_fact.go`,
// `admin_clickhouse.go`, `admin_metric_catalog.go`, `admin_data_products.go`) and only
// the fields the screens render are declared.

const count = orDefault(numberish, 0);
const text = orDefault(z.string(), "");
const flag = orDefault(z.boolean(), false);

/** Panels answer `{configured:false}` when the ClickHouse DW is not wired up yet. */
const configured = orDefault(z.boolean(), false);

export const dwOverviewSchema = looseObject({
  configured,
  since: text,
  requests: count,
  tokens: count,
  cost_krw: count,
  errors: count,
  error_rate: count,
  cost_per_request_krw: count,
  cost_per_1k_tokens_krw: count,
});
export type DwOverview = z.output<typeof dwOverviewSchema>;

export const dwTimeseriesSchema = looseObject({
  configured,
  since: text,
  bucket: text,
  points: orDefault(
    looseList({
      day: text,
      requests: count,
      tokens: count,
      cost_krw: count,
      errors: count,
    }),
    [],
  ),
});
export type DwTimeseriesPoint = z.output<typeof dwTimeseriesSchema>["points"][number];

export const dwDimensionsSchema = looseObject({
  configured,
  since: text,
  dimension: text,
  order_by: text,
  rows: orDefault(
    looseList({
      value: text,
      requests: count,
      tokens: count,
      cost_krw: count,
      errors: count,
      error_rate: count,
    }),
    [],
  ),
});
export type DwDimensionRow = z.output<typeof dwDimensionsSchema>["rows"][number];

export const dwText2SqlSchema = looseObject({
  configured,
  since: text,
  total: count,
  valid: count,
  executed: count,
  blocked: count,
  block_rate: count,
  avg_explain_risk: count,
  cost_krw: count,
  by_mode: orDefault(looseList({ mode: text, count: count, executed: count }), []),
  failures: orDefault(looseList({ reason: text, count: count }), []),
});
export type DwText2Sql = z.output<typeof dwText2SqlSchema>;

export const dwRoutingSchema = looseObject({
  configured,
  since: text,
  total: count,
  auto_routed: count,
  auto_route_rate: count,
  fallback_used: count,
  avg_complexity: count,
  avg_risk: count,
  avg_health: count,
  reasons: orDefault(looseList({ reason: text, count: count }), []),
  rewrites: orDefault(looseList({ from: text, to: text, count: count }), []),
});
export type DwRouting = z.output<typeof dwRoutingSchema>;

export const dwLatencySchema = looseObject({
  configured,
  since: text,
  total: count,
  p50_ms: count,
  p95_ms: count,
  p99_ms: count,
  avg_ms: count,
  max_ms: count,
  ttfb_p95_ms: count,
  streamed: count,
  stream_share: count,
  errors: count,
  error_rate: count,
  by_model: orDefault(
    looseList({ model: text, requests: count, p95_ms: count, errors: count, error_rate: count }),
    [],
  ),
});
export type DwLatency = z.output<typeof dwLatencySchema>;
export type DwLatencyModelRow = DwLatency["by_model"][number];

export const dwQualitySchema = looseObject({
  configured,
  since: text,
  eval: orDefault(
    looseObject({
      configured,
      total: count,
      avg_score: count,
      pass_rate: count,
      by_category: orDefault(
        looseList({ category: text, count: count, avg_score: count, pass_rate: count }),
        [],
      ),
    }),
    { configured: false, total: 0, avg_score: 0, pass_rate: 0, by_category: [] },
  ),
  feedback: orDefault(
    looseObject({
      configured,
      total: count,
      avg_rating: count,
      positive: count,
      negative: count,
      positive_rate: count,
      by_label: orDefault(looseList({ label: text, count: count }), []),
    }),
    {
      configured: false,
      total: 0,
      avg_rating: 0,
      positive: 0,
      negative: 0,
      positive_rate: 0,
      by_label: [],
    },
  ),
});
export type DwQuality = z.output<typeof dwQualitySchema>;

export const dwRefreshSchema = looseObject({ status: text, cleared: count });

const sinkStateSchema = looseObject({
  dimension: text,
  last_synced_day: text,
  last_success_at: text,
  rows_sent: count,
  updated_at: text,
});
const sinkRetrySchema = looseObject({
  dimension: text,
  since_day: text,
  error: text,
  attempts: count,
  first_failed_at: text,
  last_attempt_at: text,
});
export type DwSinkState = z.output<typeof sinkStateSchema>;
export type DwSinkRetry = z.output<typeof sinkRetrySchema>;

export const dwSinkStatusSchema = looseObject({
  configured,
  state: orDefault(z.array(sinkStateSchema), []),
  retries: orDefault(z.array(sinkRetrySchema), []),
});
export type DwSinkStatus = z.output<typeof dwSinkStatusSchema>;

export const dwSinkRetryResultSchema = looseObject({
  recovered_dimensions: count,
  sent_rows: count,
  failed: orDefault(z.record(z.string(), z.string()), {}),
});

export const dwSinkResultSchema = looseObject({
  sent_rows: count,
  since: text,
  failed: orDefault(z.record(z.string(), z.string()), {}),
  queued_for_retry: flag,
});

const consistencyTotalsSchema = looseObject({ requests: count, tokens: count, cost_krw: count });

export const dwConsistencySchema = looseObject({
  since: text,
  consistent: flag,
  dimensions: orDefault(
    z.array(
      looseObject({
        dimension: text,
        consistent: flag,
        postgres: orDefault(consistencyTotalsSchema, { requests: 0, tokens: 0, cost_krw: 0 }),
        clickhouse: orDefault(consistencyTotalsSchema, { requests: 0, tokens: 0, cost_krw: 0 }),
        diff: orDefault(consistencyTotalsSchema, { requests: 0, tokens: 0, cost_krw: 0 }),
      }),
    ),
    [],
  ),
});
export type DwConsistency = z.output<typeof dwConsistencySchema>;
export type DwConsistencyRow = DwConsistency["dimensions"][number];

export const clickhouseOverviewSchema = looseObject({
  configured,
  database: text,
  table: text,
  sink: orDefault(looseObject({ interval: text, days: count, auto_enabled: flag }), {
    interval: "",
    days: 0,
    auto_enabled: false,
  }),
  fact_table: orDefault(looseObject({ configured, name: text, exists: flag }), {
    configured: false,
    name: "",
    exists: false,
  }),
  request_fact: orDefault(
    looseObject({
      configured,
      table: text,
      queue_depth: count,
      queue_cap: count,
      dropped: count,
      batch_size: count,
      flush: text,
      retry_batches: count,
    }),
    {
      configured: false,
      table: "",
      queue_depth: 0,
      queue_cap: 0,
      dropped: 0,
      batch_size: 0,
      flush: "",
      retry_batches: 0,
    },
  ),
  ping: looseObject({ ok: flag, message: text, latency_ms: count }).optional(),
  rollup_table: looseObject({
    exists: flag,
    engine: text,
    sorting_key: text,
    replacing_merge_tree: flag,
    dedupe_ok: flag,
  }).optional(),
  watermarks: orDefault(z.array(sinkStateSchema), []),
  retries: orDefault(z.array(sinkRetrySchema), []),
  retry_count: count,
});
export type ClickhouseOverview = z.output<typeof clickhouseOverviewSchema>;

export const clickhouseLagSchema = looseObject({
  tables: orDefault(looseList({ key: text, table: text, rows: count, exists: flag }), []),
  local_requests: count,
  queue_depth: count,
  queue_cap: count,
  dropped: count,
  request_fact_rows: count,
  request_fact_lag: count,
  retry_batches: count,
});
export type ClickhouseLag = z.output<typeof clickhouseLagSchema>;
export type ClickhouseLagTable = ClickhouseLag["tables"][number];

/** ClickHouse `FORMAT JSON` passthrough: `meta`/`data`/`rows`, or `raw` when unparsable. */
export const clickhouseEventsSchema = looseObject({
  table: text,
  rows: count,
  meta: orDefault(looseList({ name: text, type: text }), []),
  data: orDefault(z.array(unknownRecord), []),
  raw: text,
});
export type ClickhouseEvents = z.output<typeof clickhouseEventsSchema>;

export const clickhouseBootstrapSchema = looseObject({
  ok: flag,
  steps: orDefault(looseList({ object: text, ok: flag, error: text }), []),
});
export type ClickhouseBootstrap = z.output<typeof clickhouseBootstrapSchema>;

export const clickhouseTestSchema = looseObject({
  ok: flag,
  message: text,
  latency_ms: count,
  ping: text,
  table_checked: text,
  table_ok: flag,
  table_message: text,
});
export type ClickhouseTest = z.output<typeof clickhouseTestSchema>;

const metricValidationSchema = looseObject({
  ok: flag,
  errors: orDefault(z.array(z.string()), []),
  warnings: orDefault(z.array(z.string()), []),
  referenced_tables: orDefault(z.array(z.string()), []),
  sensitive_refs: orDefault(z.array(z.string()), []),
  note: text,
});
export type MetricValidation = z.output<typeof metricValidationSchema>;

const metricEntrySchema = looseObject({
  id: text,
  metric_key: text,
  name_ko: text,
  description: text,
  query_template: text,
  dimensions: orDefault(z.array(z.string()), []),
  owner: text,
  sensitivity: text,
  enabled: flag,
  version: count,
  updated_by: text,
  created_at: text,
  updated_at: text,
});
export type MetricEntry = z.output<typeof metricEntrySchema>;

export const metricListSchema = looseObject({ metrics: orDefault(z.array(metricEntrySchema), []) });

export const metricUpsertSchema = looseObject({
  metric: metricEntrySchema.optional(),
  validation: metricValidationSchema.optional(),
});

/** `POST /admin/dw/metrics/{key}/validate` re-runs the static check without saving. */
export const metricValidateSchema = looseObject({
  metric_key: text,
  validation: metricValidationSchema.optional(),
});

/** `DELETE /admin/dw/metrics/{key}` answers `{"status":"deleted"}`. */
export const metricDeleteSchema = looseObject({ status: text });

const dataProductSchema = looseObject({
  id: text,
  product_key: text,
  name_ko: text,
  description: text,
  source_type: text,
  source_ref: text,
  owner: text,
  allowed_teams: orDefault(z.array(z.string()), []),
  sensitivity: text,
  status: text,
  version: count,
  updated_by: text,
  created_at: text,
  updated_at: text,
});
export type DataProduct = z.output<typeof dataProductSchema>;

export const dataProductListSchema = looseObject({
  products: orDefault(z.array(dataProductSchema), []),
});

export const dataProductCandidateListSchema = looseObject({
  since: text,
  note: text,
  candidates: orDefault(
    looseList({ question: text, count: count, last_seen: text, recommended_product: text }),
    [],
  ),
});
export type DataProductCandidate = z.output<typeof dataProductCandidateListSchema>["candidates"][number];

const dataProductRequestSchema = looseObject({
  id: text,
  product_key: text,
  user_id: text,
  team: text,
  status: text,
  reason: text,
  decided_by: text,
  created_at: text,
});
export type DataProductRequest = z.output<typeof dataProductRequestSchema>;

export const dataProductRequestListSchema = looseObject({
  requests: orDefault(z.array(dataProductRequestSchema), []),
});

export const dataProductUpsertSchema = looseObject({ product_key: text, ok: flag });
export const dataProductDeleteSchema = looseObject({ ok: flag });
export const dataProductDecisionSchema = looseObject({ id: text, status: text });

/**
 * GET /admin/savings and GET /admin/model-migration. Both are computed from the
 * operational database rather than the warehouse, and the legacy console surfaced them
 * on the DW dashboard, so the insight tab keeps them together there.
 */
export const savingsSchema = looseObject({
  dimension: orDefault(z.string(), ""),
  total_savings_krw: count,
  total_downshift_savings_krw: count,
  total_cache_savings_krw: count,
  cache_savings_estimated: z.boolean().nullish(),
  scopes: looseList({
    scope: orDefault(z.string(), ""),
    downshift_requests: count,
    downshift_savings_krw: count,
    cache_hits: count,
    cache_savings_krw: count,
    total_savings_krw: count,
  })
    .nullish()
    .transform((value) => value ?? []),
});

export const modelMigrationSchema = looseObject({
  count: count,
  total_estimated_savings_krw: count,
  recommendations: looseList({
    fingerprint: orDefault(z.string(), ""),
    task_type: orDefault(z.string(), ""),
    requests: count,
    current_model: orDefault(z.string(), ""),
    recommended_model: orDefault(z.string(), ""),
    current_success_rate: count,
    recommended_success_rate: count,
    estimated_savings_krw: count,
  })
    .nullish()
    .transform((value) => value ?? []),
});

export type Savings = z.output<typeof savingsSchema>;
export type SavingsScope = Savings["scopes"][number];
export type ModelMigration = z.output<typeof modelMigrationSchema>;
export type ModelMigrationRecommendation = ModelMigration["recommendations"][number];
