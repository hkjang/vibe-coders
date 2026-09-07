import { z } from "zod";

import type {
  DeleteAdminText2SqlColumnsData,
  DeleteAdminText2SqlGlossaryData,
  DeleteAdminText2SqlGoldenData,
  DeleteAdminText2SqlPermissionsData,
  DeleteAdminText2SqlProfilesData,
  DeleteAdminText2SqlReportsData,
  DeleteAdminText2SqlSchemasData,
  DeleteAdminText2SqlTablesData,
  GetAdminText2SqlAnomaliesData,
  GetAdminText2SqlConnectionsData,
  GetAdminText2SqlData,
  GetAdminText2SqlFeaturesData,
  GetAdminText2SqlGlossaryData,
  GetAdminText2SqlHealthcheckData,
  GetAdminText2SqlKillSwitchData,
  GetAdminText2SqlMinersData,
  GetAdminText2SqlRegistryExportData,
  GetAdminText2SqlReportsData,
  GetAdminText2SqlRiskQueueData,
  GetAdminText2SqlSpansData,
  GetAdminText2SqlTablesData,
  PostAdminText2SqlCollectData,
  PostAdminText2SqlColumnsData,
  PostAdminText2SqlConnectionsData,
  PostAdminText2SqlFeaturesData,
  PostAdminText2SqlGlossaryData,
  PostAdminText2SqlGoldenData,
  PostAdminText2SqlGoldenRunData,
  PostAdminText2SqlKillSwitchData,
  PostAdminText2SqlPermissionsData,
  PostAdminText2SqlProfilesData,
  PostAdminText2SqlPromoteData,
  PostAdminText2SqlRegistryImportData,
  PostAdminText2SqlReportsData,
  PostAdminText2SqlSchemasData,
  PostAdminText2SqlTablesData,
} from "@/shared/api/generated";
import { operation, type OperationData, type WithQuery } from "@/shared/api/endpoint-factory";
import { acknowledgementSchema, looseList, looseObject, numberish, orDefault } from "@/shared/api/loose";

/** Replaces the generated (always `never`) body with the payload the screen sends. */
type WithBody<Data extends OperationData, Body> = Omit<Data, "body"> & { readonly body: Body };

// The legacy Text2SQL admin APIs are documented without response schemas, so these
// zod shapes are the contract: they normalise the fields the screens render and let
// every other field through untouched.
const text = (fallback = "") => orDefault(z.string(), fallback);
const numeric = (fallback = 0) => orDefault(numberish, fallback);
const flag = (fallback = false) => orDefault(z.boolean(), fallback);
const stringList = () => orDefault(z.array(z.string()), [] as string[]);

const queryLogShape = {
  id: text(),
  request_id: text(),
  api_key_id: text(),
  team: text(),
  virtual_model: text(),
  upstream_model: text(),
  mode: text(),
  question: text(),
  generated_sql: text(),
  schema_name: text(),
  schema_version: numeric(),
  permission_hash: text(),
  valid: flag(),
  reject_reason: text(),
  executed: flag(),
  row_count: numeric(),
  error: text(),
  failure_category: text(),
  explain_risk: numeric(),
  cost_krw: numeric(),
  latency_ms: numeric(),
  created_at: text(),
} as const;

const schemaShape = {
  name: text(),
  team: text(),
  dialect: text(),
  schema_text: text(),
  allowed_tables: stringList(),
  is_default: flag(),
  enabled: flag(),
  version: numeric(),
  collected_at: text(),
  updated_at: text(),
} as const;

const goldenShape = {
  id: text(),
  name: text(),
  question: text(),
  expected_sql: text(),
  schema_name: text(),
  tags: stringList(),
  enabled: flag(),
  source: text(),
  created_at: text(),
  updated_at: text(),
} as const;

const profileShape = {
  virtual_model: text(),
  mode: text(),
  upstream_model: text(),
  summary_model: text(),
  schema_name: text(),
  exec_connection_id: text(),
  enabled: flag(),
  updated_at: text(),
} as const;

const permissionShape = {
  id: text(),
  subject_type: text(),
  subject_id: text(),
  schema_name: text(),
  table_name: text(),
  column_name: text(),
  action: text(),
  created_at: text(),
} as const;

const connectionShape = {
  id: text(),
  name: text(),
  driver: text(),
  description: text(),
  enabled: flag(),
  created_at: text(),
  updated_at: text(),
} as const;

const tableShape = {
  schema_name: text(),
  table_name: text(),
  description: text(),
  enabled: flag(),
  updated_at: text(),
} as const;

const columnShape = {
  schema_name: text(),
  table_name: text(),
  column_name: text(),
  data_type: text(),
  description: text(),
  sensitivity: text(),
  updated_at: text(),
} as const;

const glossaryTermShape = {
  id: text(),
  schema_name: text(),
  term: text(),
  mapping: text(),
  description: text(),
  updated_at: text(),
} as const;

const savedReportShape = {
  id: text(),
  name: text(),
  question: text(),
  schema_name: text(),
  kind: text(),
  created_by: text(),
  created_at: text(),
  schedule_interval: text(),
  schedule_enabled: flag(),
  deliver_mattermost: flag(),
  last_run_at: text(),
  team: text(),
  visibility: text(),
  approval_status: text(),
} as const;

export const text2sqlOverviewSchema = looseObject({
  enabled: flag(),
  stats: orDefault(
    looseObject({
      total: numeric(),
      valid: numeric(),
      executed: numeric(),
      errors: numeric(),
      cost_krw: numeric(),
      valid_rate: numeric(),
    }),
    { total: 0, valid: 0, executed: 0, errors: 0, cost_krw: 0, valid_rate: 0 },
  ),
  profiles: orDefault(looseList({ model: text(), mode: text(), upstream: text() }), []),
  db_profiles: orDefault(looseList(profileShape), []),
  schemas: orDefault(looseList(schemaShape), []),
  permissions: orDefault(looseList(permissionShape), []),
  golden: orDefault(looseList(goldenShape), []),
  logs: orDefault(looseList(queryLogShape), []),
  failures: orDefault(looseList({ category: text(), count: numeric() }), []),
  model_metrics: orDefault(
    looseList({
      upstream_model: text(),
      total: numeric(),
      valid: numeric(),
      executed: numeric(),
      errors: numeric(),
      valid_rate: numeric(),
      avg_cost_krw: numeric(),
      avg_latency_ms: numeric(),
    }),
    [],
  ),
  stage_metrics: orDefault(
    looseList({
      stage: text(),
      status: text(),
      model: text(),
      count: numeric(),
      error_count: numeric(),
      total_cost_krw: numeric(),
      avg_cost_krw: numeric(),
      avg_latency_ms: numeric(),
      max_latency_ms: numeric(),
      error_rate: numeric(),
    }),
    [],
  ),
});

export const text2sqlConnectionsSchema = looseObject({
  connections: orDefault(looseList(connectionShape), []),
});

export const text2sqlHealthcheckSchema = looseObject({
  status: text(),
  detail: text(),
  configured: flag(),
  reachable: orDefault(z.boolean(), false),
  driver: text(),
  statement_timeout: text(),
  connection_id: text(),
  read_only_tx_ok: orDefault(z.boolean(), false),
  statement_timeout_ok: orDefault(z.boolean(), false),
  account_write_restricted: z.boolean().nullish(),
});

export const text2sqlTablesSchema = looseObject({
  tables: orDefault(looseList(tableShape), []),
  columns: orDefault(looseList(columnShape), []),
});

export const text2sqlRegistryExportSchema = looseObject({
  version: numeric(1),
  schema: text(),
  tables: orDefault(looseList(tableShape), []),
  columns: orDefault(looseList(columnShape), []),
});

export const text2sqlRegistryImportSchema = looseObject({
  tables_imported: numeric(),
  columns_imported: numeric(),
  table_errors: numeric(),
  column_errors: numeric(),
});

export const text2sqlCollectSchema = looseObject({
  schema_name: text(),
  connection_id: text(),
  added_tables: numeric(),
  added_columns: numeric(),
});

export const text2sqlGlossarySchema = looseObject({
  terms: orDefault(looseList(glossaryTermShape), []),
  conflicts: orDefault(
    looseList({ term: text(), kind: text(), mappings: stringList(), scopes: stringList() }),
    [],
  ),
});

export const text2sqlPermissionsSchema = looseObject({
  permissions: orDefault(looseList(permissionShape), []),
});

export const text2sqlFeaturesSchema = looseObject({
  features: orDefault(looseList({ name: text(), description: text(), enabled: flag() }), []),
});

export const text2sqlKillSwitchSchema = looseObject({
  disabled: flag(),
  config_enabled: orDefault(z.boolean(), true),
});

export const text2sqlRiskQueueSchema = looseObject({
  count: numeric(),
  queue: orDefault(looseList({ log: looseObject(queryLogShape), suggestions: stringList() }), []),
});

export const text2sqlAnomaliesSchema = looseObject({
  detection_only: orDefault(z.boolean(), true),
  usage_smells: orDefault(
    looseList({ subject: text(), category: text(), count: numeric(), sample: text() }),
    [],
  ),
  risk_exposure: orDefault(
    looseList({
      team: text(),
      total: numeric(),
      rejected: numeric(),
      high_risk: numeric(),
      probes: numeric(),
      risk_score: numeric(),
    }),
    [],
  ),
  intent_drifts: orDefault(
    looseList({ subject: text(), first_seen: text(), drift_seen: text(), reason: text() }),
    [],
  ),
});

export const text2sqlMinersSchema = looseObject({
  report_candidates: orDefault(
    looseList({
      question: text(),
      count: numeric(),
      last_seen: text(),
      sample_sql: text(),
      recommended_product: text(),
    }),
    [],
  ),
  glossary_candidates: orDefault(looseList({ term: text(), count: numeric() }), []),
});

export const text2sqlReportsSchema = looseObject({
  reports: orDefault(looseList(savedReportShape), []),
});

export const text2sqlSpansSchema = looseObject({
  request_id: text(),
  spans: orDefault(
    looseList({
      id: text(),
      stage: text(),
      status: text(),
      model: text(),
      latency_ms: numeric(),
      cost_krw: numeric(),
      reject_reason: text(),
      input_hash: text(),
      output_hash: text(),
      detail: text(),
      created_at: text(),
    }),
    [],
  ),
});

export const text2sqlGoldenRunSchema = looseObject({
  model: text(),
  total: numeric(),
  passed: numeric(),
  pass_rate: numeric(),
  result_checked: numberish.nullish(),
  result_matched: numberish.nullish(),
  results: orDefault(
    looseList({
      id: text(),
      name: text(),
      valid: flag(),
      passed: flag(),
      token_match: flag(),
      result_match: z.boolean().nullish(),
      result_detail: text(),
      generated_sql: text(),
      reject_reason: text(),
    }),
    [],
  ),
});

const windowQuerySchema = z.object({ window: z.string().optional() });
const riskQueueQuerySchema = z.object({
  window: z.string().optional(),
  min_risk: z.number().optional(),
  limit: z.number().optional(),
});
const minersQuerySchema = z.object({ window: z.string().optional(), min_count: z.number().optional() });
const schemaQuerySchema = z.object({ schema: z.string().optional() });
const idQuerySchema = z.object({ id: z.string() });
const nameQuerySchema = z.object({ name: z.string() });
const virtualModelQuerySchema = z.object({ virtual_model: z.string() });
const tableQuerySchema = z.object({ schema: z.string(), table: z.string() });
const columnQuerySchema = z.object({ schema: z.string(), table: z.string(), column: z.string() });
const connectionQuerySchema = z.object({ connection_id: z.string().optional() });
const spansQuerySchema = z.object({ request_id: z.string() });

export interface Text2SQLSchemaInput {
  name: string;
  team?: string;
  dialect?: string;
  schema_text: string;
  allowed_tables?: readonly string[];
  is_default?: boolean;
  enabled?: boolean;
}

export interface Text2SQLProfileInput {
  virtual_model: string;
  mode: string;
  upstream_model?: string;
  summary_model?: string;
  schema_name?: string;
  exec_connection_id?: string;
  enabled?: boolean;
}

export interface Text2SQLConnectionInput {
  id: string;
  name: string;
  driver: string;
  dsn?: string;
  description?: string;
  enabled?: boolean;
}

export interface Text2SQLTableInput {
  schema_name: string;
  table_name: string;
  description?: string;
  enabled?: boolean;
}

export interface Text2SQLColumnInput {
  schema_name: string;
  table_name: string;
  column_name: string;
  data_type?: string;
  description?: string;
  sensitivity?: string;
}

export interface Text2SQLPermissionInput {
  subject_type: string;
  subject_id: string;
  schema_name: string;
  table_name: string;
  column_name: string;
  action: string;
}

export interface Text2SQLGlossaryInput {
  schema_name?: string;
  term: string;
  mapping: string;
  description?: string;
}

export interface Text2SQLGoldenInput {
  id?: string;
  name: string;
  question: string;
  expected_sql: string;
  schema_name?: string;
  tags?: readonly string[];
  enabled?: boolean;
}

export interface Text2SQLPromoteInput {
  target: "report" | "golden" | "glossary";
  name?: string;
  question?: string;
  sql?: string;
  schema_name?: string;
  kind?: string;
  term?: string;
  mapping?: string;
}

export interface Text2SQLReportScheduleInput {
  id: string;
  interval: string;
  enabled: boolean;
  deliver_mattermost: boolean;
}

export interface Text2SQLRegistryImportInput {
  tables: ReadonlyArray<Record<string, unknown>>;
  columns: ReadonlyArray<Record<string, unknown>>;
}

export const text2sqlEndpoints = {
  overview: operation<WithQuery<GetAdminText2SqlData, { window?: string }>, unknown>()(
    "GET",
    "/admin/text2sql",
    text2sqlOverviewSchema,
    windowQuerySchema,
  ),
  spans: operation<WithQuery<GetAdminText2SqlSpansData, { request_id: string }>, unknown>()(
    "GET",
    "/admin/text2sql/spans",
    text2sqlSpansSchema,
    spansQuerySchema,
  ),
  schemas: {
    save: operation<WithBody<PostAdminText2SqlSchemasData, Text2SQLSchemaInput>, unknown>()(
      "POST",
      "/admin/text2sql/schemas",
      acknowledgementSchema,
    ),
    remove: operation<WithQuery<DeleteAdminText2SqlSchemasData, { name: string }>, unknown>()(
      "DELETE",
      "/admin/text2sql/schemas",
      acknowledgementSchema,
      nameQuerySchema,
    ),
  },
  profiles: {
    save: operation<WithBody<PostAdminText2SqlProfilesData, Text2SQLProfileInput>, unknown>()(
      "POST",
      "/admin/text2sql/profiles",
      acknowledgementSchema,
    ),
    remove: operation<WithQuery<DeleteAdminText2SqlProfilesData, { virtual_model: string }>, unknown>()(
      "DELETE",
      "/admin/text2sql/profiles",
      acknowledgementSchema,
      virtualModelQuerySchema,
    ),
  },
  connections: {
    list: operation<GetAdminText2SqlConnectionsData, unknown>()(
      "GET",
      "/admin/text2sql/connections",
      text2sqlConnectionsSchema,
    ),
    save: operation<WithBody<PostAdminText2SqlConnectionsData, Text2SQLConnectionInput>, unknown>()(
      "POST",
      "/admin/text2sql/connections",
      acknowledgementSchema,
    ),
    // DELETE /admin/text2sql/connections exists on the server but is absent from the
    // generated OpenAPI operation list, so it cannot be declared here yet.
    // Probes the execute database, so it must stay behind an explicit button.
    healthcheck: operation<WithQuery<GetAdminText2SqlHealthcheckData, { connection_id?: string }>, unknown>()(
      "GET",
      "/admin/text2sql/healthcheck",
      text2sqlHealthcheckSchema,
      connectionQuerySchema,
    ),
  },
  registry: {
    tables: operation<WithQuery<GetAdminText2SqlTablesData, { schema?: string }>, unknown>()(
      "GET",
      "/admin/text2sql/tables",
      text2sqlTablesSchema,
      schemaQuerySchema,
    ),
    saveTable: operation<WithBody<PostAdminText2SqlTablesData, Text2SQLTableInput>, unknown>()(
      "POST",
      "/admin/text2sql/tables",
      acknowledgementSchema,
    ),
    removeTable: operation<
      WithQuery<DeleteAdminText2SqlTablesData, { schema: string; table: string }>,
      unknown
    >()("DELETE", "/admin/text2sql/tables", acknowledgementSchema, tableQuerySchema),
    saveColumn: operation<WithBody<PostAdminText2SqlColumnsData, Text2SQLColumnInput>, unknown>()(
      "POST",
      "/admin/text2sql/columns",
      acknowledgementSchema,
    ),
    removeColumn: operation<
      WithQuery<DeleteAdminText2SqlColumnsData, { schema: string; table: string; column: string }>,
      unknown
    >()("DELETE", "/admin/text2sql/columns", acknowledgementSchema, columnQuerySchema),
    collect: operation<
      WithBody<
        PostAdminText2SqlCollectData,
        { schema_name: string; db_schema?: string; connection_id?: string }
      >,
      unknown
    >()("POST", "/admin/text2sql/collect", text2sqlCollectSchema),
    export: operation<WithQuery<GetAdminText2SqlRegistryExportData, { schema?: string }>, unknown>()(
      "GET",
      "/admin/text2sql/registry/export",
      text2sqlRegistryExportSchema,
      schemaQuerySchema,
    ),
    import: operation<WithBody<PostAdminText2SqlRegistryImportData, Text2SQLRegistryImportInput>, unknown>()(
      "POST",
      "/admin/text2sql/registry/import",
      text2sqlRegistryImportSchema,
    ),
  },
  permissions: {
    save: operation<WithBody<PostAdminText2SqlPermissionsData, Text2SQLPermissionInput>, unknown>()(
      "POST",
      "/admin/text2sql/permissions",
      acknowledgementSchema,
    ),
    remove: operation<WithQuery<DeleteAdminText2SqlPermissionsData, { id: string }>, unknown>()(
      "DELETE",
      "/admin/text2sql/permissions",
      acknowledgementSchema,
      idQuerySchema,
    ),
  },
  glossary: {
    list: operation<WithQuery<GetAdminText2SqlGlossaryData, { schema?: string }>, unknown>()(
      "GET",
      "/admin/text2sql/glossary",
      text2sqlGlossarySchema,
      schemaQuerySchema,
    ),
    save: operation<WithBody<PostAdminText2SqlGlossaryData, Text2SQLGlossaryInput>, unknown>()(
      "POST",
      "/admin/text2sql/glossary",
      acknowledgementSchema,
    ),
    remove: operation<WithQuery<DeleteAdminText2SqlGlossaryData, { id: string }>, unknown>()(
      "DELETE",
      "/admin/text2sql/glossary",
      acknowledgementSchema,
      idQuerySchema,
    ),
  },
  features: {
    list: operation<GetAdminText2SqlFeaturesData, unknown>()(
      "GET",
      "/admin/text2sql/features",
      text2sqlFeaturesSchema,
    ),
    toggle: operation<WithBody<PostAdminText2SqlFeaturesData, { name: string; enabled: boolean }>, unknown>()(
      "POST",
      "/admin/text2sql/features",
      acknowledgementSchema,
    ),
  },
  killSwitch: {
    read: operation<GetAdminText2SqlKillSwitchData, unknown>()(
      "GET",
      "/admin/text2sql/kill-switch",
      text2sqlKillSwitchSchema,
    ),
    set: operation<WithBody<PostAdminText2SqlKillSwitchData, { disabled: boolean }>, unknown>()(
      "POST",
      "/admin/text2sql/kill-switch",
      text2sqlKillSwitchSchema,
    ),
  },
  riskQueue: operation<
    WithQuery<GetAdminText2SqlRiskQueueData, { window?: string; min_risk?: number; limit?: number }>,
    unknown
  >()("GET", "/admin/text2sql/risk-queue", text2sqlRiskQueueSchema, riskQueueQuerySchema),
  anomalies: operation<WithQuery<GetAdminText2SqlAnomaliesData, { window?: string }>, unknown>()(
    "GET",
    "/admin/text2sql/anomalies",
    text2sqlAnomaliesSchema,
    windowQuerySchema,
  ),
  miners: operation<
    WithQuery<GetAdminText2SqlMinersData, { window?: string; min_count?: number }>,
    unknown
  >()("GET", "/admin/text2sql/miners", text2sqlMinersSchema, minersQuerySchema),
  reports: {
    list: operation<GetAdminText2SqlReportsData, unknown>()(
      "GET",
      "/admin/text2sql/reports",
      text2sqlReportsSchema,
    ),
    schedule: operation<WithBody<PostAdminText2SqlReportsData, Text2SQLReportScheduleInput>, unknown>()(
      "POST",
      "/admin/text2sql/reports",
      acknowledgementSchema,
    ),
    remove: operation<WithQuery<DeleteAdminText2SqlReportsData, { id: string }>, unknown>()(
      "DELETE",
      "/admin/text2sql/reports",
      acknowledgementSchema,
      idQuerySchema,
    ),
  },
  promote: operation<WithBody<PostAdminText2SqlPromoteData, Text2SQLPromoteInput>, unknown>()(
    "POST",
    "/admin/text2sql/promote",
    acknowledgementSchema,
  ),
  golden: {
    save: operation<WithBody<PostAdminText2SqlGoldenData, Text2SQLGoldenInput>, unknown>()(
      "POST",
      "/admin/text2sql/golden",
      acknowledgementSchema,
    ),
    remove: operation<WithQuery<DeleteAdminText2SqlGoldenData, { id: string }>, unknown>()(
      "DELETE",
      "/admin/text2sql/golden",
      acknowledgementSchema,
      idQuerySchema,
    ),
    run: operation<WithBody<PostAdminText2SqlGoldenRunData, { model?: string }>, unknown>()(
      "POST",
      "/admin/text2sql/golden/run",
      text2sqlGoldenRunSchema,
    ),
  },
} as const;

export type Text2SQLOverview = z.output<typeof text2sqlOverviewSchema>;
export type Text2SQLQueryLog = Text2SQLOverview["logs"][number];
export type Text2SQLSchemaRow = Text2SQLOverview["schemas"][number];
export type Text2SQLProfileRow = Text2SQLOverview["db_profiles"][number];
export type Text2SQLPermissionRow = Text2SQLOverview["permissions"][number];
export type Text2SQLGoldenRow = Text2SQLOverview["golden"][number];
export type Text2SQLConnectionRow = z.output<typeof text2sqlConnectionsSchema>["connections"][number];
export type Text2SQLTableRow = z.output<typeof text2sqlTablesSchema>["tables"][number];
export type Text2SQLColumnRow = z.output<typeof text2sqlTablesSchema>["columns"][number];
export type Text2SQLGlossaryTerm = z.output<typeof text2sqlGlossarySchema>["terms"][number];
export type Text2SQLFeatureRow = z.output<typeof text2sqlFeaturesSchema>["features"][number];
export type Text2SQLRiskEntry = z.output<typeof text2sqlRiskQueueSchema>["queue"][number];
export type Text2SQLAnomalies = z.output<typeof text2sqlAnomaliesSchema>;
export type Text2SQLMiners = z.output<typeof text2sqlMinersSchema>;
export type Text2SQLSavedReport = z.output<typeof text2sqlReportsSchema>["reports"][number];
export type Text2SQLGoldenRun = z.output<typeof text2sqlGoldenRunSchema>;
export type Text2SQLHealthcheck = z.output<typeof text2sqlHealthcheckSchema>;
export type Text2SQLSpan = z.output<typeof text2sqlSpansSchema>["spans"][number];
