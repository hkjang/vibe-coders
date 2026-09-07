// security domain endpoints. Declare every server call this domain's screens make
// here with `operation()` from "@/shared/api/endpoint-factory" and a zod schema
// (see "@/shared/api/loose" for legacy responses without a documented shape).
import { z } from "zod";

import { operation, type OperationData, type WithQuery } from "@/shared/api/endpoint-factory";
import type {
  GetAdminAnomaliesData,
  GetAdminAuditAuthEventsData,
  GetAdminAuditLogsData,
  GetAdminPrivacyLedgerData,
  GetAdminSecuritySecretsData,
  GetSecurityDashboardData,
  PostAdminSandboxPreviewData,
} from "@/shared/api/generated";
import { looseObject, numberish, orDefault } from "@/shared/api/loose";

/** Replaces the generated (undocumented) body with an app-defined request type. */
type WithBody<Data extends OperationData, Body> = Omit<Data, "body"> & { readonly body: Body };

const text = orDefault(z.string(), "");
const count = orDefault(numberish, 0);
const counters = orDefault(z.record(z.string(), numberish), {});
const flag = orDefault(z.boolean(), false);
const words = orDefault(z.array(z.string()), []);

/** Windows the legacy screens offered; the server also accepts Go duration strings. */
export const securityWindows = ["24h", "7d", "30d"] as const;
export type SecurityWindow = (typeof securityWindows)[number];

export const privacyLedgerDimensions = ["team", "model", "provider"] as const;
export type PrivacyLedgerDimension = (typeof privacyLedgerDimensions)[number];

export const secretEventActions = ["detect", "mask", "block"] as const;
export const sandboxKinds = ["chat", "text2sql", "mcp"] as const;
export type SandboxKind = (typeof sandboxKinds)[number];

// --- GET /security/dashboard -------------------------------------------------

const policyViolationSchema = looseObject({
  decision: text,
  reason: text,
  rule: text,
  endpoint: text,
  risk_score: count,
  created_at: text,
});

const riskyToolSchema = looseObject({
  id: text,
  server_label: text,
  tool_name: text,
  risk_level: text,
  action: text,
  note: text,
});

const approvalSchema = looseObject({
  id: text,
  subject_type: text,
  subject_id: text,
  status: text,
  reason: text,
  risk_score: count,
  created_at: text,
});

export const securityDashboardSchema = looseObject({
  since: text,
  policy: looseObject({
    by_decision: counters,
    blocked: count,
    warned: count,
    recent: orDefault(z.array(policyViolationSchema), []),
  }).optional(),
  secrets: looseObject({ total: count, by_type: counters }).optional(),
  mcp_summary: looseObject({
    total_calls: count,
    total_errors: count,
    distinct_tools: count,
    mcp_servers: count,
  }).optional(),
  risky_tools: orDefault(z.array(riskyToolSchema), []),
  pending_approvals: orDefault(z.array(approvalSchema), []),
  pending_count: count,
});

export type SecurityDashboard = z.output<typeof securityDashboardSchema>;
export type SecurityPolicyViolation = z.output<typeof policyViolationSchema>;
export type SecurityRiskyTool = z.output<typeof riskyToolSchema>;
export type SecurityApproval = z.output<typeof approvalSchema>;

const securityDashboardQuerySchema = z.object({ window: z.enum(securityWindows).optional() });
export type SecurityDashboardQuery = z.infer<typeof securityDashboardQuerySchema>;

// --- GET /admin/audit/auth-events and /admin/audit-logs ----------------------

const authEventSchema = looseObject({
  id: text,
  event_type: text,
  actor_user_id: text,
  api_key_id: text,
  team_id: text,
  ip: text,
  user_agent: text,
  detail: text,
  created_at: text,
});

export const authEventsSchema = looseObject({ events: orDefault(z.array(authEventSchema), []) });
export type AuthEvent = z.output<typeof authEventSchema>;

const auditLogSchema = looseObject({
  id: text,
  admin_id: text,
  action: text,
  before_value: text,
  after_value: text,
  created_at: text,
});

export const auditLogsSchema = looseObject({ audit_logs: orDefault(z.array(auditLogSchema), []) });
export type AdminAuditLog = z.output<typeof auditLogSchema>;

const auditLimitQuerySchema = z.object({ limit: z.number().int().positive().max(200).optional() });
export type AuditLimitQuery = z.infer<typeof auditLimitQuerySchema>;

// --- GET /admin/security/secrets ---------------------------------------------

const secretEventSchema = looseObject({
  id: text,
  request_id: text,
  api_key_id: text,
  user_id: text,
  team_id: text,
  secret_type: text,
  action: text,
  location: text,
  // A short digest of the matched value; the server never returns the secret itself.
  matched_hash: text,
  created_at: text,
});

export const secretEventsSchema = looseObject({
  secret_events: orDefault(z.array(secretEventSchema), []),
  count: count,
});
export type SecretEvent = z.output<typeof secretEventSchema>;

const secretEventsQuerySchema = z.object({
  window: z.enum(securityWindows).optional(),
  limit: z.number().int().positive().max(200).optional(),
  action: z.enum(secretEventActions).optional(),
  secret_type: z.string().optional(),
});
export type SecretEventsQuery = z.infer<typeof secretEventsQuerySchema>;

// --- GET /admin/anomalies -----------------------------------------------------

const anomalyFindingSchema = looseObject({
  model: text,
  metric: text,
  baseline_mean: count,
  baseline_std: count,
  recent_mean: count,
  z_score: count,
  direction: text,
  baseline_samples: count,
  recent_samples: count,
});

const costAnomalySchema = looseObject({
  scope: text,
  scope_value: text,
  metric: text,
  baseline_mean: count,
  baseline_std: count,
  recent_value: count,
  z_score: count,
  direction: text,
  baseline_buckets: count,
  recent_samples: count,
});

const anomalyEventSchema = looseObject({
  id: text,
  scope: text,
  scope_value: text,
  metric: text,
  value: count,
  baseline: count,
  severity: text,
  channel: text,
  status: text,
  created_at: text,
});

export const anomaliesSchema = looseObject({
  anomalies: orDefault(z.array(anomalyFindingSchema), []),
  cost_anomalies: orDefault(z.array(costAnomalySchema), []),
  detected_events: orDefault(z.array(anomalyEventSchema), []),
  events: orDefault(z.array(anomalyEventSchema), []),
  z_threshold: count,
});
export type AnomalyFinding = z.output<typeof anomalyFindingSchema>;
export type CostAnomaly = z.output<typeof costAnomalySchema>;
export type AnomalyEvent = z.output<typeof anomalyEventSchema>;

const anomaliesQuerySchema = z.object({
  recent: z.string().optional(),
  baseline: z.string().optional(),
  z: z.number().positive().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type AnomaliesQuery = z.infer<typeof anomaliesQuerySchema>;

// --- GET /admin/privacy-ledger ------------------------------------------------

const privacyLedgerRowSchema = looseObject({
  dim_value: text,
  detections: count,
  masked: count,
  blocked: count,
  egress_requests: count,
  egress_tokens: count,
});

export const privacyLedgerSchema = looseObject({
  dimension: text,
  days: count,
  rows: orDefault(z.array(privacyLedgerRowSchema), []),
  totals: looseObject({
    detections: count,
    masked: count,
    blocked: count,
    egress_requests: count,
    egress_tokens: count,
  }).optional(),
  note: text,
});
export type PrivacyLedgerRow = z.output<typeof privacyLedgerRowSchema>;
export type PrivacyLedger = z.output<typeof privacyLedgerSchema>;

const privacyLedgerQuerySchema = z.object({
  dimension: z.enum(privacyLedgerDimensions),
  days: z.number().int().positive().max(365).optional(),
});
export type PrivacyLedgerQuery = z.infer<typeof privacyLedgerQuerySchema>;

// --- POST /admin/sandbox/preview ----------------------------------------------

/** Sandbox input. `content` and `sql` are evaluated in memory and never stored. */
export interface SandboxPreviewBody {
  kind: SandboxKind;
  model?: string;
  provider?: string;
  team?: string;
  content?: string;
  sql?: string;
  server?: string;
  tool?: string;
}

export const sandboxPreviewSchema = looseObject({
  kind: text,
  would_block: flag,
  reasons: words,
  note: text,
  checks: looseObject({
    prompt_injection: looseObject({ families: words, severity: count }).optional(),
    secrets: looseObject({ types: words, count: count }).optional(),
    policy: looseObject({ outcome: text, reason: text, secret_action: text }).optional(),
    text2sql_validation: looseObject({
      ok: flag,
      reason: text,
      tables: words,
      limit_added: flag,
    }).optional(),
    mcp_tool_risk: looseObject({ risk_level: text, action: text, profiled: flag }).optional(),
  }).optional(),
});
export type SandboxPreview = z.output<typeof sandboxPreviewSchema>;

export const securityEndpoints = {
  dashboard: operation<WithQuery<GetSecurityDashboardData, SecurityDashboardQuery>, unknown>()(
    "GET",
    "/security/dashboard",
    securityDashboardSchema,
    securityDashboardQuerySchema,
  ),
  authEvents: operation<WithQuery<GetAdminAuditAuthEventsData, AuditLimitQuery>, unknown>()(
    "GET",
    "/admin/audit/auth-events",
    authEventsSchema,
    auditLimitQuerySchema,
  ),
  auditLogs: operation<WithQuery<GetAdminAuditLogsData, AuditLimitQuery>, unknown>()(
    "GET",
    "/admin/audit-logs",
    auditLogsSchema,
    auditLimitQuerySchema,
  ),
  secretEvents: operation<WithQuery<GetAdminSecuritySecretsData, SecretEventsQuery>, unknown>()(
    "GET",
    "/admin/security/secrets",
    secretEventsSchema,
    secretEventsQuerySchema,
  ),
  anomalies: operation<WithQuery<GetAdminAnomaliesData, AnomaliesQuery>, unknown>()(
    "GET",
    "/admin/anomalies",
    anomaliesSchema,
    anomaliesQuerySchema,
  ),
  privacyLedger: operation<WithQuery<GetAdminPrivacyLedgerData, PrivacyLedgerQuery>, unknown>()(
    "GET",
    "/admin/privacy-ledger",
    privacyLedgerSchema,
    privacyLedgerQuerySchema,
  ),
  sandboxPreview: operation<WithBody<PostAdminSandboxPreviewData, SandboxPreviewBody>, unknown>()(
    "POST",
    "/admin/sandbox/preview",
    sandboxPreviewSchema,
  ),
} as const;
