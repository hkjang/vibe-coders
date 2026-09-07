// governance domain endpoints. Declare every server call this domain's screens make
// here with `operation()` from "@/shared/api/endpoint-factory" and a zod schema
// (see "@/shared/api/loose" for legacy responses without a documented shape).
import { z } from "zod";

import { operation, type OperationData, type WithQuery } from "@/shared/api/endpoint-factory";
import type {
  DeleteAdminAlertsIdData,
  DeleteAdminModelDeprecationsIdData,
  DeleteAdminPoliciesRegressionCasesData,
  GetAdminAlertsData,
  GetAdminApprovalsData,
  GetAdminIncidentsData,
  GetAdminKillSwitchData,
  GetAdminModelDeprecationsData,
  GetAdminPoliciesCanaryStatusData,
  GetAdminPoliciesData,
  GetAdminPoliciesDecisionsData,
  GetAdminPoliciesRegressionCasesData,
  GetAdminPolicyAdvisorSuggestionsData,
  GetAdminRemediationPlaybooksData,
  GetAdminSecuritySecretsData,
  PostAdminAlertsData,
  PostAdminApprovalsIdApproveData,
  PostAdminApprovalsIdRejectData,
  PostAdminKillSwitchData,
  PostAdminModelDeprecationsData,
  PostAdminPoliciesData,
  PostAdminPoliciesRegressionCasesData,
  PostAdminPoliciesRegressionRunData,
  PostAdminPoliciesSimulateData,
  PostAdminPolicyAdvisorApplyData,
  PostAdminRemediationApplyData,
} from "@/shared/api/generated";
import { looseList, looseObject, numberish, unknownRecord } from "@/shared/api/loose";

/**
 * The generated operation types declare `body?: never` for the legacy admin
 * routes, which would make the typed client refuse a request body. Each mutation
 * below restates the body the Go handler decodes.
 */
type WithBody<Data extends OperationData, Body> = Omit<Data, "body"> & { readonly body: Body };

// ---------- kill switch ----------

const killSwitchSchema = looseObject({
  disabled: z.boolean(),
  reason: z.string().optional(),
  updated_at: z.string().optional(),
  updated_by: z.string().optional(),
});
export type KillSwitchState = z.infer<typeof killSwitchSchema>;

export interface KillSwitchBody {
  readonly disabled: boolean;
  readonly reason: string;
}

// ---------- alert rules ----------

const alertRuleSchema = looseObject({
  id: z.string(),
  name: z.string().optional(),
  metric: z.string().optional(),
  window_seconds: numberish.optional(),
  threshold: numberish.optional(),
  scope: z.string().optional(),
  scope_value: z.string().optional(),
  webhook_url: z.string().optional(),
  enabled: z.boolean().optional(),
  note: z.string().optional(),
  created_at: z.string().optional(),
  last_fired_at: z.string().nullish(),
  last_value: numberish.optional(),
});
export type AlertRule = z.infer<typeof alertRuleSchema>;

const alertEventSchema = looseObject({
  id: z.string(),
  rule_id: z.string().optional(),
  rule_name: z.string().optional(),
  metric: z.string().optional(),
  value: numberish.optional(),
  threshold: numberish.optional(),
  delivered: z.boolean().optional(),
  delivery_error: z.string().optional(),
  created_at: z.string().optional(),
});
export type AlertEvent = z.infer<typeof alertEventSchema>;

const alertListSchema = looseObject({
  rules: z.array(alertRuleSchema).nullish(),
  events: z.array(alertEventSchema).nullish(),
});

export interface AlertRuleBody {
  readonly name: string;
  readonly metric: string;
  readonly window_seconds: number;
  readonly threshold: number;
  readonly scope: string;
  readonly scope_value: string;
  readonly webhook_url: string;
  readonly note: string;
}

// ---------- policy engine ----------

const policyRuleSchema = looseObject({
  id: z.string().optional(),
  policy_id: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  priority: numberish.optional(),
  conditions: unknownRecord.nullish(),
  actions: unknownRecord.nullish(),
});
export type PolicyRule = z.infer<typeof policyRuleSchema>;

const policySchema = looseObject({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  priority: numberish.optional(),
  rollout_percent: numberish.optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  rules: z.array(policyRuleSchema).nullish(),
});
export type Policy = z.infer<typeof policySchema>;

const policyListSchema = looseObject({ policies: z.array(policySchema).nullish() });
const policySaveSchema = looseObject({ policy: policySchema.optional() });

export interface PolicyRuleBody {
  readonly id?: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly conditions: Readonly<Record<string, unknown>>;
  readonly actions: Readonly<Record<string, unknown>>;
}

export interface PolicyBody {
  readonly id?: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly rollout_percent: number;
  readonly rules: readonly PolicyRuleBody[];
}

// ---------- policy decisions / approvals / secret events ----------

const governanceEventQuerySchema = z.object({
  window: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  request_id: z.string().optional(),
  api_key_id: z.string().optional(),
  user_id: z.string().optional(),
  team_id: z.string().optional(),
});

const policyDecisionQuerySchema = governanceEventQuerySchema.extend({
  decision: z.string().optional(),
  policy_id: z.string().optional(),
  model: z.string().optional(),
  endpoint: z.string().optional(),
  phase: z.string().optional(),
});
export type PolicyDecisionQuery = z.infer<typeof policyDecisionQuerySchema>;

const policyDecisionListSchema = looseObject({
  policy_decisions: looseList({
    id: z.string(),
    request_id: z.string().optional(),
    api_key_id: z.string().optional(),
    user_id: z.string().optional(),
    team_id: z.string().optional(),
    endpoint: z.string().optional(),
    phase: z.string().optional(),
    policy_id: z.string().optional(),
    rule_id: z.string().optional(),
    rule_name: z.string().optional(),
    decision: z.string().optional(),
    reason: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    risk_score: numberish.optional(),
    cost_krw: numberish.optional(),
    created_at: z.string().optional(),
  }).nullish(),
  count: numberish.optional(),
});

const approvalQuerySchema = governanceEventQuerySchema.extend({
  status: z.string().optional(),
  subject_type: z.string().optional(),
  subject_id: z.string().optional(),
});
export type ApprovalQuery = z.infer<typeof approvalQuerySchema>;

const approvalSchema = looseObject({
  id: z.string(),
  request_id: z.string().optional(),
  api_key_id: z.string().optional(),
  user_id: z.string().optional(),
  team_id: z.string().optional(),
  subject_type: z.string().optional(),
  subject_id: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  risk_score: numberish.optional(),
  cost_krw: numberish.optional(),
  expires_at: z.string().optional(),
  decided_by: z.string().optional(),
  decided_at: z.string().optional(),
  created_at: z.string().optional(),
});
export type Approval = z.infer<typeof approvalSchema>;

const approvalListSchema = looseObject({
  approvals: z.array(approvalSchema).nullish(),
  count: numberish.optional(),
});

const secretEventQuerySchema = governanceEventQuerySchema.extend({
  secret_type: z.string().optional(),
  action: z.string().optional(),
  location: z.string().optional(),
});
export type SecretEventQuery = z.infer<typeof secretEventQuerySchema>;

const secretEventListSchema = looseObject({
  secret_events: looseList({
    id: z.string(),
    request_id: z.string().optional(),
    api_key_id: z.string().optional(),
    user_id: z.string().optional(),
    team_id: z.string().optional(),
    secret_type: z.string().optional(),
    action: z.string().optional(),
    location: z.string().optional(),
    matched_hash: z.string().optional(),
    created_at: z.string().optional(),
  }).nullish(),
  count: numberish.optional(),
});

// ---------- incidents ----------

const incidentQuerySchema = z.object({
  window: z.string().optional(),
  min_events: z.number().int().positive().optional(),
});
export type IncidentQuery = z.infer<typeof incidentQuerySchema>;

const incidentListSchema = looseObject({
  incidents: looseList({
    provider: z.string().optional(),
    started_at: z.string().optional(),
    ended_at: z.string().optional(),
    failovers: numberish.optional(),
    errors_5xx: numberish.optional(),
    affected_users: numberish.optional(),
    requests: numberish.optional(),
    ongoing: z.boolean().optional(),
  }).nullish(),
  min_events: numberish.optional(),
});

// ---------- policy regression ----------

const regressionCaseSchema = looseObject({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  team_id: z.string().optional(),
  role: z.string().optional(),
  endpoint: z.string().optional(),
  complexity_score: numberish.optional(),
  risk_score: numberish.optional(),
  contains_secret: z.boolean().optional(),
  secret_types: z.array(z.string()).nullish(),
  mcp_server: z.string().optional(),
  mcp_tool: z.string().optional(),
  expect: z.string().optional(),
  expect_secret_action: z.string().optional(),
  enabled: z.boolean().optional(),
  created_by: z.string().optional(),
  updated_at: z.string().optional(),
});
export type PolicyRegressionCase = z.infer<typeof regressionCaseSchema>;

const regressionCaseListSchema = looseObject({ cases: z.array(regressionCaseSchema).nullish() });
const regressionCaseSaveSchema = looseObject({ id: z.string().optional(), ok: z.boolean().optional() });
const regressionDeleteSchema = looseObject({ ok: z.boolean().optional() });

export interface PolicyRegressionCaseBody {
  readonly name: string;
  readonly model: string;
  readonly provider: string;
  readonly risk_score: number;
  readonly contains_secret: boolean;
  readonly expect: string;
}

const regressionRunSchema = looseObject({
  rule_source: z.string().optional(),
  rule_count: numberish.optional(),
  total: numberish.optional(),
  passed: numberish.optional(),
  failed: numberish.optional(),
  ran_at: z.string().optional(),
  results: looseList({
    id: z.string().optional(),
    name: z.string().optional(),
    expect: z.string().optional(),
    actual: z.string().optional(),
    expect_secret_action: z.string().optional(),
    actual_secret_action: z.string().optional(),
    pass: z.boolean().optional(),
    reason: z.string().optional(),
  }).nullish(),
});
export type PolicyRegressionRun = z.infer<typeof regressionRunSchema>;

// ---------- policy advisor ----------

const policySuggestionSchema = looseObject({
  id: z.string(),
  title: z.string().optional(),
  severity: z.string().optional(),
  rationale: z.string().optional(),
  evidence: unknownRecord.nullish(),
  conditions: unknownRecord.nullish(),
  actions: unknownRecord.nullish(),
});
export type PolicySuggestion = z.infer<typeof policySuggestionSchema>;

const advisorQuerySchema = z.object({ window: z.string().optional() });
export type AdvisorQuery = z.infer<typeof advisorQuerySchema>;

const advisorSuggestionsSchema = looseObject({
  window: z.string().optional(),
  note: z.string().optional(),
  suggestions: z.array(policySuggestionSchema).nullish(),
});

const advisorApplySchema = looseObject({
  policy_id: z.string().optional(),
  enabled: z.boolean().optional(),
  note: z.string().optional(),
});

export interface AdvisorApplyBody {
  readonly title: string;
  readonly conditions: Readonly<Record<string, unknown>>;
  readonly actions: Readonly<Record<string, unknown>>;
}

const canaryQuerySchema = z.object({ days: z.number().int().positive().max(90).optional() });
export type CanaryQuery = z.infer<typeof canaryQuerySchema>;

const canaryStatusSchema = looseObject({
  days: numberish.optional(),
  note: z.string().optional(),
  policies: looseList({
    policy_id: z.string(),
    name: z.string().optional(),
    rollout_percent: numberish.optional(),
    enforced_acts: numberish.optional(),
    shadow_acts: numberish.optional(),
    suggested_next: numberish.optional(),
  }).nullish(),
});

const simulateSchema = looseObject({
  evaluated: numberish.optional(),
  blocked: numberish.optional(),
  require_approval: numberish.optional(),
  allowed: numberish.optional(),
  block_rate: numberish.optional(),
  since: z.string().optional(),
  shadow: looseObject({
    affected_keys: numberish.optional(),
    affected_teams: numberish.optional(),
    false_positive_candidates: numberish.optional(),
    false_positive_rate: numberish.optional(),
    blocked_cost_krw: numberish.optional(),
    false_positive_sample: z.array(unknownRecord).nullish(),
  }).nullish(),
});
export type PolicySimulation = z.infer<typeof simulateSchema>;

export interface PolicySimulateBody {
  readonly rules: ReadonlyArray<{
    readonly name: string;
    readonly conditions: Readonly<Record<string, unknown>>;
    readonly actions: Readonly<Record<string, unknown>>;
  }>;
  readonly window?: string;
}

// ---------- model deprecations ----------

const modelDeprecationSchema = looseObject({
  id: z.string(),
  model_glob: z.string().optional(),
  replacement: z.string().optional(),
  sunset_date: z.string().optional(),
  message: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type ModelDeprecation = z.infer<typeof modelDeprecationSchema>;

const modelDeprecationListSchema = looseObject({
  deprecations: z.array(modelDeprecationSchema).nullish(),
});
const modelDeprecationSaveSchema = looseObject({ deprecation: modelDeprecationSchema.optional() });
const modelDeprecationDeleteSchema = looseObject({
  id: z.string().optional(),
  status: z.string().optional(),
});

export interface ModelDeprecationBody {
  readonly model_glob: string;
  readonly replacement: string;
  readonly sunset_date: string;
  readonly message: string;
}

// ---------- remediation playbooks ----------

const remediationActionSchema = looseObject({
  id: z.string(),
  type: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  severity: z.string().optional(),
  executable: z.boolean().optional(),
  reversible: z.boolean().optional(),
  dry_run: z.string().optional(),
  expected_impact: z.string().optional(),
  params: unknownRecord.nullish(),
  link: z.string().optional(),
});
export type RemediationAction = z.infer<typeof remediationActionSchema>;

const remediationPlaybookSchema = looseObject({
  situation: z.string().optional(),
  severity: z.string().optional(),
  summary: z.string().optional(),
  actions: z.array(remediationActionSchema).nullish(),
});
export type RemediationPlaybook = z.infer<typeof remediationPlaybookSchema>;

const remediationQuerySchema = z.object({ window: z.string().optional() });
export type RemediationQuery = z.infer<typeof remediationQuerySchema>;

const remediationPlaybookListSchema = looseObject({
  overall_severity: z.string().optional(),
  window_hours: numberish.optional(),
  note: z.string().optional(),
  playbooks: z.array(remediationPlaybookSchema).nullish(),
});

const remediationApplySchema = looseObject({
  applied: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  action_type: z.string().optional(),
  before: unknownRecord.nullish(),
  after: unknownRecord.nullish(),
  rollback: looseObject({
    action_type: z.string().optional(),
    params: unknownRecord.nullish(),
  }).nullish(),
  note: z.string().optional(),
});
export type RemediationApplyResult = z.infer<typeof remediationApplySchema>;

export interface RemediationApplyBody {
  readonly action_type: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly dry_run: boolean;
}

export const governanceEndpoints = {
  killSwitch: {
    get: operation<GetAdminKillSwitchData, unknown>()("GET", "/admin/kill-switch", killSwitchSchema),
    set: operation<WithBody<PostAdminKillSwitchData, KillSwitchBody>, unknown>()(
      "POST",
      "/admin/kill-switch",
      killSwitchSchema,
    ),
  },
  alerts: {
    list: operation<GetAdminAlertsData, unknown>()("GET", "/admin/alerts", alertListSchema),
    create: operation<WithBody<PostAdminAlertsData, AlertRuleBody>, unknown>()(
      "POST",
      "/admin/alerts",
      looseObject({ rule: alertRuleSchema.optional() }),
    ),
    remove: operation<DeleteAdminAlertsIdData, unknown>()(
      "DELETE",
      "/admin/alerts/{id}",
      looseObject({ id: z.string().optional(), status: z.string().optional() }),
    ),
  },
  policies: {
    list: operation<GetAdminPoliciesData, unknown>()("GET", "/admin/policies", policyListSchema),
    save: operation<WithBody<PostAdminPoliciesData, PolicyBody>, unknown>()(
      "POST",
      "/admin/policies",
      policySaveSchema,
    ),
    decisions: operation<WithQuery<GetAdminPoliciesDecisionsData, PolicyDecisionQuery>, unknown>()(
      "GET",
      "/admin/policies/decisions",
      policyDecisionListSchema,
      policyDecisionQuerySchema,
    ),
    canaryStatus: operation<WithQuery<GetAdminPoliciesCanaryStatusData, CanaryQuery>, unknown>()(
      "GET",
      "/admin/policies/canary-status",
      canaryStatusSchema,
      canaryQuerySchema,
    ),
    simulate: operation<WithBody<PostAdminPoliciesSimulateData, PolicySimulateBody>, unknown>()(
      "POST",
      "/admin/policies/simulate",
      simulateSchema,
    ),
  },
  regression: {
    list: operation<GetAdminPoliciesRegressionCasesData, unknown>()(
      "GET",
      "/admin/policies/regression/cases",
      regressionCaseListSchema,
    ),
    save: operation<WithBody<PostAdminPoliciesRegressionCasesData, PolicyRegressionCaseBody>, unknown>()(
      "POST",
      "/admin/policies/regression/cases",
      regressionCaseSaveSchema,
    ),
    remove: operation<WithQuery<DeleteAdminPoliciesRegressionCasesData, { readonly id: string }>, unknown>()(
      "DELETE",
      "/admin/policies/regression/cases",
      regressionDeleteSchema,
      z.object({ id: z.string() }),
    ),
    run: operation<PostAdminPoliciesRegressionRunData, unknown>()(
      "POST",
      "/admin/policies/regression/run",
      regressionRunSchema,
    ),
  },
  approvals: {
    list: operation<WithQuery<GetAdminApprovalsData, ApprovalQuery>, unknown>()(
      "GET",
      "/admin/approvals",
      approvalListSchema,
      approvalQuerySchema,
    ),
    // The documented path folds the decision into `{id}` ("{id}/approve|/reject").
    approve: operation<PostAdminApprovalsIdApproveData, unknown>()(
      "POST",
      "/admin/approvals/{id}/approve",
      z.unknown(),
    ),
    reject: operation<PostAdminApprovalsIdRejectData, unknown>()(
      "POST",
      "/admin/approvals/{id}/reject",
      z.unknown(),
    ),
  },
  secretEvents: operation<WithQuery<GetAdminSecuritySecretsData, SecretEventQuery>, unknown>()(
    "GET",
    "/admin/security/secrets",
    secretEventListSchema,
    secretEventQuerySchema,
  ),
  incidents: operation<WithQuery<GetAdminIncidentsData, IncidentQuery>, unknown>()(
    "GET",
    "/admin/incidents",
    incidentListSchema,
    incidentQuerySchema,
  ),
  modelDeprecations: {
    list: operation<GetAdminModelDeprecationsData, unknown>()(
      "GET",
      "/admin/model-deprecations",
      modelDeprecationListSchema,
    ),
    create: operation<WithBody<PostAdminModelDeprecationsData, ModelDeprecationBody>, unknown>()(
      "POST",
      "/admin/model-deprecations",
      modelDeprecationSaveSchema,
    ),
    remove: operation<DeleteAdminModelDeprecationsIdData, unknown>()(
      "DELETE",
      "/admin/model-deprecations/{id}",
      modelDeprecationDeleteSchema,
    ),
  },
  advisor: {
    suggestions: operation<WithQuery<GetAdminPolicyAdvisorSuggestionsData, AdvisorQuery>, unknown>()(
      "GET",
      "/admin/policy-advisor/suggestions",
      advisorSuggestionsSchema,
      advisorQuerySchema,
    ),
    apply: operation<WithBody<PostAdminPolicyAdvisorApplyData, AdvisorApplyBody>, unknown>()(
      "POST",
      "/admin/policy-advisor/apply",
      advisorApplySchema,
    ),
  },
  remediation: {
    playbooks: operation<WithQuery<GetAdminRemediationPlaybooksData, RemediationQuery>, unknown>()(
      "GET",
      "/admin/remediation/playbooks",
      remediationPlaybookListSchema,
      remediationQuerySchema,
    ),
    apply: operation<WithBody<PostAdminRemediationApplyData, RemediationApplyBody>, unknown>()(
      "POST",
      "/admin/remediation/apply",
      remediationApplySchema,
    ),
  },
} as const;

export type AlertListResult = z.infer<typeof alertListSchema>;
export type PolicyListResult = z.infer<typeof policyListSchema>;
export type PolicyDecisionListResult = z.infer<typeof policyDecisionListSchema>;
export type ApprovalListResult = z.infer<typeof approvalListSchema>;
export type SecretEventListResult = z.infer<typeof secretEventListSchema>;
export type IncidentListResult = z.infer<typeof incidentListSchema>;
export type CanaryStatusResult = z.infer<typeof canaryStatusSchema>;
export type AdvisorSuggestionsResult = z.infer<typeof advisorSuggestionsSchema>;
export type ModelDeprecationListResult = z.infer<typeof modelDeprecationListSchema>;
export type RemediationPlaybookListResult = z.infer<typeof remediationPlaybookListSchema>;
export type RegressionCaseListResult = z.infer<typeof regressionCaseListSchema>;
