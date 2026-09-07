import { z } from "zod";

import { acknowledgementSchema, looseList, looseObject, numberish, unknownRecord } from "@/shared/api/loose";

// Response contracts for the system domain. The legacy admin API documents no
// response schemas, so these declare only the fields the screens render and let
// every other field through (see "@/shared/api/loose").

/** One resolution layer of a runtime setting (env, DB override, runtime, request). */
export const settingLayerSchema = looseObject({
  name: z.string(),
  source: z.string(),
  configured: z.boolean(),
  active: z.boolean(),
  value: z.string(),
  is_set: z.boolean(),
  writable: z.boolean(),
  version: numberish.optional(),
  updated_by: z.string().optional(),
  updated_at: z.string().optional(),
});

export const settingViewSchema = looseObject({
  key: z.string(),
  category: z.string(),
  type: z.string(),
  description: z.string(),
  is_secret: z.boolean(),
  is_set: z.boolean().optional(),
  read_only: z.boolean(),
  restart_required: z.boolean(),
  source: z.string(),
  value: z.string(),
  value_error: z.string().optional(),
  version: numberish.optional(),
  updated_at: z.string().optional(),
  updated_by: z.string().optional(),
  permission_group: z.string().optional(),
  can_write: z.boolean().optional(),
});

export const effectiveSettingSchema = settingViewSchema.extend({
  effective_source: z.string().optional(),
  active_layer: z.string().optional(),
  layers: z.array(settingLayerSchema).optional(),
});

export const podReloadStatusSchema = looseObject({
  hostname: z.string().optional(),
  last_reload_at: z.string().optional(),
  up_to_date: z.boolean().optional(),
  reload_interval: z.string().optional(),
});

export const effectiveSettingsSchema = looseObject({
  settings: z.array(effectiveSettingSchema).default([]),
  category: z.string().optional(),
  resolution_order: z.array(z.string()).optional(),
  this_pod: podReloadStatusSchema.optional(),
});

export const settingHistorySchema = looseObject({
  history: looseList({
    id: z.string(),
    key: z.string(),
    old_value_json: z.string().optional(),
    new_value_json: z.string().optional(),
    is_secret: z.boolean().optional(),
    changed_by: z.string().optional(),
    reason: z.string().optional(),
    changed_at: z.string().optional(),
  }).default([]),
});

export const settingExportSchema = looseObject({
  settings: looseList({ key: z.string(), value: z.string() }).default([]),
  note: z.string().optional(),
});

/** Connection probes return `ok:false` with a message instead of an HTTP error. */
export const connectionTestSchema = looseObject({
  ok: z.boolean().optional(),
  message: z.string().optional(),
  driver: z.string().optional(),
  latency_ms: numberish.optional(),
  ping: z.string().optional(),
  table_checked: z.string().optional(),
  table_ok: z.boolean().optional(),
  table_message: z.string().optional(),
  warning: z.string().optional(),
});

export const changeSetItemSchema = looseObject({
  kind: z.string().optional(),
  key: z.string().optional(),
  value: z.string().optional(),
  note: z.string().optional(),
});

export const changeSetSchema = looseObject({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  items: z.array(changeSetItemSchema).nullish(),
  prior: z.array(changeSetItemSchema).nullish(),
  canary_scope: z.string().optional(),
  created_by: z.string().optional(),
  reviewer: z.string().optional(),
  note: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  applied_at: z.string().optional(),
});

export const changeSetListSchema = looseObject({
  change_sets: z.array(changeSetSchema).nullish(),
});

/** One line of a change-set dry run: current vs proposed effective value. */
export const changeSetDryRunCheckSchema = looseObject({
  kind: z.string().optional(),
  key: z.string().optional(),
  proposed: z.string().optional(),
  current: z.string().optional(),
  source: z.string().optional(),
  changed: z.boolean().optional(),
  valid: z.boolean().optional(),
  detail: z.string().optional(),
  restart_required: z.boolean().optional(),
  applied_by_gateway: z.boolean().optional(),
});

export const changeSetDryRunSchema = looseObject({
  change_set_id: z.string().optional(),
  status: z.string().optional(),
  checks: z.array(changeSetDryRunCheckSchema).nullish(),
  changed_count: numberish.optional(),
  invalid_count: numberish.optional(),
  restart_required: z.boolean().optional(),
  canary_scope: z.string().optional(),
  note: z.string().optional(),
});

/** apply/rollback answer with the finished set plus how many settings moved. */
export const changeSetApplySchema = looseObject({
  status: z.string().optional(),
  applied_count: numberish.optional(),
  restored_count: numberish.optional(),
  change_set: changeSetSchema.optional(),
});

export const changeImpactSchema = looseObject({
  change_type: z.string().optional(),
  window_days: numberish.optional(),
  baseline: unknownRecord.optional(),
  impact: unknownRecord.optional(),
  note: z.string().optional(),
});

export const systemErrorListSchema = looseObject({
  errors: looseList({
    id: z.string(),
    component: z.string().optional(),
    error_message: z.string().optional(),
    created_at: z.string().optional(),
  }).nullish(),
});

export const keycloakConfigSchema = looseObject({
  enabled: z.boolean(),
  issuer_url: z.string().optional(),
  client_id: z.string().optional(),
  client_secret_set: z.boolean().optional(),
  redirect_uri: z.string().optional(),
  scopes: z.array(z.string()).nullish(),
  default_role: z.string().optional(),
  role_claim: z.string().optional(),
  group_claim: z.string().optional(),
  allow_local_login: z.boolean().optional(),
  role_map: z.record(z.string(), z.string()).nullish(),
  role_map_default: z.record(z.string(), z.string()).nullish(),
  role_map_custom: z.boolean().optional(),
  source: z.string().optional(),
  db_backed: z.boolean().optional(),
  updated_at: z.string().optional(),
  updated_by: z.string().optional(),
  version: numberish.optional(),
});

export const keycloakTestSchema = looseObject({
  ok: z.boolean().optional(),
  reason: z.string().optional(),
  stage: z.string().optional(),
  issuer: z.string().optional(),
  authorization_endpoint: z.string().optional(),
  token_endpoint: z.string().optional(),
  jwks_uri: z.string().optional(),
  end_session_endpoint: z.string().optional(),
  rsa_signing_keys: numberish.optional(),
});

export const roleCatalogSchema = looseObject({
  roles: looseList({
    role: z.string(),
    description: z.string().optional(),
    is_system: z.boolean().optional(),
  }).nullish(),
});

export const auditLogListSchema = looseObject({
  audit_logs: looseList({
    id: z.string(),
    admin_id: z.string().optional(),
    action: z.string().optional(),
    before_value: z.string().optional(),
    after_value: z.string().optional(),
    created_at: z.string().optional(),
  }).nullish(),
});

export const authEventListSchema = looseObject({
  events: looseList({
    id: z.string(),
    event_type: z.string().optional(),
    actor_user_id: z.string().optional(),
    api_key_id: z.string().optional(),
    team_id: z.string().optional(),
    ip: z.string().optional(),
    detail: z.string().optional(),
    created_at: z.string().optional(),
  }).nullish(),
});

export const retentionStatusSchema = looseObject({
  request_days: numberish.optional(),
  prompt_days: numberish.optional(),
  response_days: numberish.optional(),
  requests: numberish.optional(),
  prompts: numberish.optional(),
  responses: numberish.optional(),
  last_run_at: z.string().optional(),
  last_deleted: numberish.optional(),
});

export const fallbackStatsSchema = looseObject({
  path: z.string().optional(),
  exists: z.boolean().optional(),
  bytes: numberish.optional(),
  lines: numberish.optional(),
  modified_at: z.string().optional(),
});

export const fallbackReplaySchema = looseObject({
  path: z.string().optional(),
  imported: numberish.optional(),
  duplicates: numberish.optional(),
  failed: numberish.optional(),
  remaining: numberish.optional(),
  removed: z.boolean().optional(),
});

export const notificationConfigSchema = looseObject({
  enabled: z.boolean().optional(),
  webhook_url: z.string().optional(),
  channel: z.string().optional(),
  events: z.array(z.string()).nullish(),
  available_events: z.array(z.string()).nullish(),
});

export const notificationTestSchema = looseObject({
  status: z.string().optional(),
  webhook_status: numberish.optional(),
});

export const systemAcknowledgementSchema = acknowledgementSchema;

/** PUT /admin/sso/keycloak/config answers 204 with no body. */
export const emptyBodySchema = z.unknown();

export const recentLimitQuerySchema = z.object({ limit: z.number().int().positive().max(200).optional() });
export const settingHistoryQuerySchema = z.object({
  key: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export const settingRevertQuerySchema = z.object({
  reason: z.string().optional(),
  expected_version: z.number().int().nonnegative().optional(),
});
export const systemErrorQuerySchema = z.object({ limit: z.number().int().positive().max(1000).optional() });

export type EffectiveSetting = z.output<typeof effectiveSettingSchema>;
export type SettingHistoryEntry = z.output<typeof settingHistorySchema>["history"][number];
export type ChangeSet = z.output<typeof changeSetSchema>;
export type ChangeSetDryRun = z.output<typeof changeSetDryRunSchema>;
export type ChangeSetDryRunCheck = z.output<typeof changeSetDryRunCheckSchema>;
export type ChangeSetApplyResult = z.output<typeof changeSetApplySchema>;
export type SystemErrorRow = NonNullable<z.output<typeof systemErrorListSchema>["errors"]>[number];
export type KeycloakConfig = z.output<typeof keycloakConfigSchema>;
export type AuditLogRow = NonNullable<z.output<typeof auditLogListSchema>["audit_logs"]>[number];
export type AuthEventRow = NonNullable<z.output<typeof authEventListSchema>["events"]>[number];
export type NotificationConfig = z.output<typeof notificationConfigSchema>;
export type ConnectionTestResult = z.output<typeof connectionTestSchema>;
export type KeycloakTestResult = z.output<typeof keycloakTestSchema>;
export type ChangeImpactResult = z.output<typeof changeImpactSchema>;
