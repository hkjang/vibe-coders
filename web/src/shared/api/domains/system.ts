// system domain endpoints. Declare every server call this domain's screens make
// here with `operation()` from "@/shared/api/endpoint-factory" and a zod schema
// (see "@/shared/api/loose" for legacy responses without a documented shape).
import type {
  DeleteAdminChangeSetsIdData,
  DeleteAdminSettingsByKeyKeyData,
  DeleteAdminSettingsByKeyKeyResponse,
  GetAdminAuditAuthEventsData,
  GetAdminAuditLogsData,
  GetAdminChangeSetsData,
  GetAdminChangeSetsIdData,
  GetAdminFallbackData,
  GetAdminNotificationsMattermostData,
  GetAdminRetentionData,
  GetAdminRolesData,
  GetAdminSettingsEffectiveData,
  GetAdminSettingsExportData,
  GetAdminSettingsHistoryData,
  GetAdminSsoKeycloakConfigData,
  GetAdminSystemErrorsData,
  PostAdminChangeImpactSimulateData,
  PostAdminChangeSetsData,
  PostAdminChangeSetsIdApplyData,
  PostAdminChangeSetsIdApproveData,
  PostAdminChangeSetsIdDryrunData,
  PostAdminChangeSetsIdRollbackData,
  PostAdminChangeSetsIdSubmitData,
  PostAdminFallbackData,
  PostAdminNotificationsMattermostData,
  PostAdminNotificationsMattermostTestData,
  PostAdminRetentionData,
  PostAdminSettingsRollbackData,
  PostAdminSettingsTestClickhouseData,
  PostAdminSettingsTestText2SqlExecData,
  PostAdminSettingsTestText2SqlTwinData,
  PostAdminSsoKeycloakTestData,
  PostAdminSystemErrorsClearData,
  PutAdminSettingsByKeyKeyData,
  PutAdminSettingsByKeyKeyResponse,
  PutAdminSsoKeycloakConfigData,
} from "@/shared/api/generated";
import { operation, type WithBody, type WithQuery } from "@/shared/api/endpoint-factory";
import {
  auditLogListSchema,
  authEventListSchema,
  changeImpactSchema,
  changeSetApplySchema,
  changeSetDryRunSchema,
  changeSetListSchema,
  changeSetSchema,
  connectionTestSchema,
  effectiveSettingsSchema,
  emptyBodySchema,
  fallbackReplaySchema,
  fallbackStatsSchema,
  keycloakConfigSchema,
  keycloakTestSchema,
  notificationConfigSchema,
  notificationTestSchema,
  recentLimitQuerySchema,
  retentionStatusSchema,
  roleCatalogSchema,
  settingExportSchema,
  settingHistoryQuerySchema,
  settingHistorySchema,
  settingRevertQuerySchema,
  settingViewSchema,
  systemAcknowledgementSchema,
  systemErrorListSchema,
  systemErrorQuerySchema,
} from "@/shared/api/domains/system.schemas";

export interface SettingWriteBody {
  value: string;
  reason?: string;
  expected_version?: number;
}

export interface SettingRollbackBody {
  key: string;
  reason?: string;
}

export interface ChangeSetCreateBody {
  title: string;
  description?: string;
  canary_scope?: string;
  items: ReadonlyArray<{ kind: string; key: string; value: string; note?: string }>;
}

/** submit/approve record an optional reviewer note on the change set. */
export interface ChangeSetNoteBody {
  note?: string;
}

export interface ChangeImpactBody {
  change_type: string;
  days: number;
  params: Record<string, string | number>;
}

export interface KeycloakConfigBody {
  enabled: boolean;
  issuer_url: string;
  client_id: string;
  redirect_uri: string;
  scopes?: readonly string[];
  default_role?: string;
  role_claim?: string;
  group_claim?: string;
  allow_local_login: boolean;
  /** Omitted keeps the stored secret; "" clears it. Never read back from the server. */
  client_secret?: string;
  role_map?: Record<string, string>;
  expected_version?: number;
}

export interface NotificationConfigBody {
  enabled?: boolean;
  webhook_url?: string;
  channel?: string;
  events?: readonly string[];
}

export const systemEndpoints = {
  settings: {
    effective: operation<GetAdminSettingsEffectiveData, unknown>()(
      "GET",
      "/admin/settings/effective",
      effectiveSettingsSchema,
    ),
    update: operation<
      WithBody<PutAdminSettingsByKeyKeyData, SettingWriteBody>,
      PutAdminSettingsByKeyKeyResponse
    >()("PUT", "/admin/settings/by-key/{key}", settingViewSchema),
    revert: operation<DeleteAdminSettingsByKeyKeyData, DeleteAdminSettingsByKeyKeyResponse>()(
      "DELETE",
      "/admin/settings/by-key/{key}",
      settingViewSchema,
      settingRevertQuerySchema,
    ),
    rollback: operation<WithBody<PostAdminSettingsRollbackData, SettingRollbackBody>, unknown>()(
      "POST",
      "/admin/settings/rollback",
      settingViewSchema,
    ),
    history: operation<WithQuery<GetAdminSettingsHistoryData, { key?: string; limit?: number }>, unknown>()(
      "GET",
      "/admin/settings/history",
      settingHistorySchema,
      settingHistoryQuerySchema,
    ),
    export: operation<GetAdminSettingsExportData, unknown>()(
      "GET",
      "/admin/settings/export",
      settingExportSchema,
    ),
    testClickhouse: operation<PostAdminSettingsTestClickhouseData, unknown>()(
      "POST",
      "/admin/settings/test/clickhouse",
      connectionTestSchema,
    ),
    testText2sqlExec: operation<PostAdminSettingsTestText2SqlExecData, unknown>()(
      "POST",
      "/admin/settings/test/text2sql-exec",
      connectionTestSchema,
    ),
    testText2sqlTwin: operation<PostAdminSettingsTestText2SqlTwinData, unknown>()(
      "POST",
      "/admin/settings/test/text2sql-twin",
      connectionTestSchema,
    ),
  },
  changeSets: {
    list: operation<GetAdminChangeSetsData, unknown>()("GET", "/admin/change-sets", changeSetListSchema),
    create: operation<WithBody<PostAdminChangeSetsData, ChangeSetCreateBody>, unknown>()(
      "POST",
      "/admin/change-sets",
      changeSetSchema,
    ),
    detail: operation<GetAdminChangeSetsIdData, unknown>()("GET", "/admin/change-sets/{id}", changeSetSchema),
    remove: operation<DeleteAdminChangeSetsIdData, unknown>()(
      "DELETE",
      "/admin/change-sets/{id}",
      systemAcknowledgementSchema,
    ),
    dryRun: operation<PostAdminChangeSetsIdDryrunData, unknown>()(
      "POST",
      "/admin/change-sets/{id}/dryrun",
      changeSetDryRunSchema,
    ),
    submit: operation<WithBody<PostAdminChangeSetsIdSubmitData, ChangeSetNoteBody>, unknown>()(
      "POST",
      "/admin/change-sets/{id}/submit",
      changeSetSchema,
    ),
    approve: operation<WithBody<PostAdminChangeSetsIdApproveData, ChangeSetNoteBody>, unknown>()(
      "POST",
      "/admin/change-sets/{id}/approve",
      changeSetSchema,
    ),
    apply: operation<WithBody<PostAdminChangeSetsIdApplyData, ChangeSetNoteBody>, unknown>()(
      "POST",
      "/admin/change-sets/{id}/apply",
      changeSetApplySchema,
    ),
    rollback: operation<WithBody<PostAdminChangeSetsIdRollbackData, ChangeSetNoteBody>, unknown>()(
      "POST",
      "/admin/change-sets/{id}/rollback",
      changeSetApplySchema,
    ),
    simulateImpact: operation<WithBody<PostAdminChangeImpactSimulateData, ChangeImpactBody>, unknown>()(
      "POST",
      "/admin/change-impact/simulate",
      changeImpactSchema,
    ),
  },
  systemErrors: {
    list: operation<WithQuery<GetAdminSystemErrorsData, { limit?: number }>, unknown>()(
      "GET",
      "/admin/system-errors",
      systemErrorListSchema,
      systemErrorQuerySchema,
    ),
    clear: operation<PostAdminSystemErrorsClearData, unknown>()(
      "POST",
      "/admin/system-errors/clear",
      systemAcknowledgementSchema,
    ),
  },
  sso: {
    config: operation<GetAdminSsoKeycloakConfigData, unknown>()(
      "GET",
      "/admin/sso/keycloak/config",
      keycloakConfigSchema,
    ),
    save: operation<WithBody<PutAdminSsoKeycloakConfigData, KeycloakConfigBody>, unknown>()(
      "PUT",
      "/admin/sso/keycloak/config",
      emptyBodySchema,
    ),
    test: operation<PostAdminSsoKeycloakTestData, unknown>()(
      "POST",
      "/admin/sso/keycloak/test",
      keycloakTestSchema,
    ),
  },
  roles: operation<GetAdminRolesData, unknown>()("GET", "/admin/roles", roleCatalogSchema),
  audit: {
    logs: operation<WithQuery<GetAdminAuditLogsData, { limit?: number }>, unknown>()(
      "GET",
      "/admin/audit-logs",
      auditLogListSchema,
      recentLimitQuerySchema,
    ),
    authEvents: operation<WithQuery<GetAdminAuditAuthEventsData, { limit?: number }>, unknown>()(
      "GET",
      "/admin/audit/auth-events",
      authEventListSchema,
      recentLimitQuerySchema,
    ),
  },
  retention: {
    status: operation<GetAdminRetentionData, unknown>()("GET", "/admin/retention", retentionStatusSchema),
    run: operation<PostAdminRetentionData, unknown>()("POST", "/admin/retention", retentionStatusSchema),
  },
  fallback: {
    status: operation<GetAdminFallbackData, unknown>()("GET", "/admin/fallback", fallbackStatsSchema),
    replay: operation<PostAdminFallbackData, unknown>()("POST", "/admin/fallback", fallbackReplaySchema),
  },
  notifications: {
    config: operation<GetAdminNotificationsMattermostData, unknown>()(
      "GET",
      "/admin/notifications/mattermost",
      notificationConfigSchema,
    ),
    save: operation<WithBody<PostAdminNotificationsMattermostData, NotificationConfigBody>, unknown>()(
      "POST",
      "/admin/notifications/mattermost",
      notificationConfigSchema,
    ),
    test: operation<PostAdminNotificationsMattermostTestData, unknown>()(
      "POST",
      "/admin/notifications/mattermost/test",
      notificationTestSchema,
    ),
  },
} as const;
