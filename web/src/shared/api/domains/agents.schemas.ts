// Response contracts for the agents domain (workflows, AI work apps, skills).
// The legacy admin APIs ship without documented response schemas, so these zod
// schemas are the contract: only the fields the screens render are declared and
// everything else passes through (`looseObject`).
import { z } from "zod";

import { looseList, looseObject, numberish, unknownRecord } from "@/shared/api/loose";

const optionalText = z.string().optional();
const optionalNumber = numberish.optional();
const optionalFlag = z.boolean().optional();

// ── workflows ───────────────────────────────────────────────────────────────

export const workflowStepSchema = looseObject({
  name: optionalText,
  type: optionalText,
  ref: optionalText,
  timeout_ms: optionalNumber,
  max_cost_krw: optionalNumber,
  max_tokens: optionalNumber,
  allowed_tools: z.array(z.string()).nullish(),
  allowed_tables: z.array(z.string()).nullish(),
  note: optionalText,
});
export type WorkflowStep = z.output<typeof workflowStepSchema>;

export const workflowSchema = looseObject({
  id: z.string(),
  name: optionalText,
  description: optionalText,
  steps: z.array(workflowStepSchema).nullish(),
  allowed_teams: optionalText,
  enabled: optionalFlag,
  created_by: optionalText,
  created_at: optionalText,
  updated_at: optionalText,
});
export type Workflow = z.output<typeof workflowSchema>;

export const workflowListSchema = looseObject({
  workflows: z.array(workflowSchema).nullish(),
});

export const workflowUpsertSchema = looseObject({ id: optionalText, ok: optionalFlag });

export const workflowDryRunStepSchema = looseObject({
  name: optionalText,
  type: optionalText,
  ref: optionalText,
  resolved: optionalFlag,
  detail: optionalText,
  limits: unknownRecord.nullish(),
});

export const workflowDryRunSchema = looseObject({
  workflow_id: optionalText,
  name: optionalText,
  steps: z.array(workflowDryRunStepSchema).nullish(),
  issues: z.array(z.string()).nullish(),
  ok: optionalFlag,
  note: optionalText,
});
export type WorkflowDryRun = z.output<typeof workflowDryRunSchema>;

export const workflowPublishSchema = looseObject({
  workflow_id: optionalText,
  version: optionalNumber,
  enabled: optionalFlag,
  published: optionalFlag,
});

export const workflowVersionListSchema = looseObject({
  workflow_id: optionalText,
  versions: looseList({
    id: optionalText,
    workflow_id: optionalText,
    version: optionalNumber,
    name: optionalText,
    description: optionalText,
    steps: z.array(workflowStepSchema).nullish(),
    allowed_teams: optionalText,
    published_by: optionalText,
    published_at: optionalText,
    note: optionalText,
  }).nullish(),
});
export type WorkflowVersion = NonNullable<z.output<typeof workflowVersionListSchema>["versions"]>[number];

export const workflowRunSchema = looseObject({
  id: z.string(),
  workflow_id: optionalText,
  user_id: optionalText,
  team: optionalText,
  status: optionalText,
  steps_total: optionalNumber,
  steps_ok: optionalNumber,
  latency_ms: optionalNumber,
  cost_krw: optionalNumber,
  error_class: optionalText,
  trace_id: optionalText,
  created_at: optionalText,
});
export type WorkflowRun = z.output<typeof workflowRunSchema>;

export const workflowRunListSchema = looseObject({ runs: z.array(workflowRunSchema).nullish() });

export const workflowRunReceiptSchema = looseObject({
  run_id: optionalText,
  kind: optionalText,
  workflow_id: optionalText,
  workflow_name: optionalText,
  status: optionalText,
  error_class: optionalText,
  steps_total: optionalNumber,
  steps_ok: optionalNumber,
  latency_ms: optionalNumber,
  cost_krw: optionalNumber,
  created_at: optionalText,
  steps: looseList({
    step_index: optionalNumber,
    name: optionalText,
    type: optionalText,
    ref: optionalText,
    status: optionalText,
    output_chars: optionalNumber,
    error_class: optionalText,
  }).nullish(),
  note: optionalText,
});
export type WorkflowRunReceipt = z.output<typeof workflowRunReceiptSchema>;

export interface WorkflowUpsertBody {
  id?: string;
  name: string;
  description?: string;
  steps: ReadonlyArray<{
    name: string;
    type: string;
    ref?: string;
    timeout_ms?: number;
    max_cost_krw?: number;
    max_tokens?: number;
    allowed_tools?: readonly string[];
    allowed_tables?: readonly string[];
    note?: string;
  }>;
  allowed_teams?: string;
  enabled?: boolean;
}
export interface WorkflowDeleteQuery {
  id: string;
}
export interface WorkflowPublishBody {
  note?: string;
}
export interface WorkflowRunsQuery {
  workflow_id?: string;
  limit?: number;
}

// ── AI work apps ────────────────────────────────────────────────────────────

export const appComponentSchema = looseObject({
  kind: optionalText,
  ref: optionalText,
  label: optionalText,
});
export type AppComponent = z.output<typeof appComponentSchema>;

export const workAppSchema = looseObject({
  id: z.string(),
  title: optionalText,
  description: optionalText,
  icon: optionalText,
  components: z.array(appComponentSchema).nullish(),
  allowed_teams: optionalText,
  allowed_roles: optionalText,
  status: optionalText,
  owner: optionalText,
  created_at: optionalText,
  updated_at: optionalText,
});
export type WorkApp = z.output<typeof workAppSchema>;

export const workAppListSchema = looseObject({ apps: z.array(workAppSchema).nullish() });

export const appValidationSchema = looseObject({
  ok: optionalFlag,
  checks: looseList({
    kind: optionalText,
    ref: optionalText,
    label: optionalText,
    resolved: optionalFlag,
    detail: optionalText,
  }).nullish(),
  allowed_models: z.array(z.string()).nullish(),
  warnings: z.array(z.string()).nullish(),
});
export type AppValidation = z.output<typeof appValidationSchema>;

export const publishAcknowledgementSchema = looseObject({
  id: optionalText,
  version: optionalNumber,
  status: optionalText,
  published: optionalFlag,
});

export const appVersionListSchema = looseObject({
  app_id: optionalText,
  versions: looseList({
    id: optionalText,
    app_id: optionalText,
    version: optionalNumber,
    title: optionalText,
    description: optionalText,
    icon: optionalText,
    components: z.array(appComponentSchema).nullish(),
    allowed_teams: optionalText,
    allowed_roles: optionalText,
    published_by: optionalText,
    published_at: optionalText,
    note: optionalText,
  }).nullish(),
});
export type AppVersion = NonNullable<z.output<typeof appVersionListSchema>["versions"]>[number];

export const appPermissionListSchema = looseObject({
  app_id: optionalText,
  permissions: looseList({
    id: optionalText,
    app_id: optionalText,
    subject_type: optionalText,
    subject_id: optionalText,
    granted_by: optionalText,
    created_at: optionalText,
  }).nullish(),
});
export type AppPermission = NonNullable<z.output<typeof appPermissionListSchema>["permissions"]>[number];

export const onboardingCheckSchema = looseObject({
  key: optionalText,
  ok: optionalFlag,
  severity: optionalText,
  detail: optionalText,
});
export type OnboardingCheck = z.output<typeof onboardingCheckSchema>;

export const appOnboardingSchema = looseObject({
  ready: optionalFlag,
  checks: z.array(onboardingCheckSchema).nullish(),
  missing: optionalNumber,
  note: optionalText,
});
export type AppOnboarding = z.output<typeof appOnboardingSchema>;

export const appRunPlanSchema = looseObject({
  run_id: optionalText,
  app_id: optionalText,
  title: optionalText,
  status: optionalText,
  plan: looseList({
    kind: optionalText,
    ref: optionalText,
    label: optionalText,
    action: optionalText,
    endpoint: optionalText,
    hint: optionalText,
    resolved: optionalFlag,
    detail: optionalText,
  }).nullish(),
  note: optionalText,
});
export type AppRunPlan = z.output<typeof appRunPlanSchema>;

export const appRunSchema = looseObject({
  id: z.string(),
  app_id: optionalText,
  user_id: optionalText,
  team: optionalText,
  status: optionalText,
  input_hash: optionalText,
  output_summary: optionalText,
  error_class: optionalText,
  latency_ms: optionalNumber,
  cost_krw: optionalNumber,
  trace_id: optionalText,
  created_at: optionalText,
});
export type AppRun = z.output<typeof appRunSchema>;

export const appRunListSchema = looseObject({ runs: z.array(appRunSchema).nullish() });

export const appRunReceiptSchema = looseObject({
  run_id: optionalText,
  kind: optionalText,
  app_id: optionalText,
  app_title: optionalText,
  status: optionalText,
  error_class: optionalText,
  output_summary: optionalText,
  input_hash: optionalText,
  latency_ms: optionalNumber,
  cost_krw: optionalNumber,
  created_at: optionalText,
  note: optionalText,
});
export type AppRunReceipt = z.output<typeof appRunReceiptSchema>;

export const appTemplateListSchema = looseObject({
  templates: looseList({
    key: z.string(),
    title: optionalText,
    description: optionalText,
    icon: optionalText,
    category: optionalText,
    components: z.array(appComponentSchema).nullish(),
  }).nullish(),
  note: optionalText,
});
export type AppTemplate = NonNullable<z.output<typeof appTemplateListSchema>["templates"]>[number];

export const appTemplateInstantiateSchema = looseObject({
  app_id: optionalText,
  template: optionalText,
  note: optionalText,
});

export interface WorkAppWriteBody {
  title: string;
  description?: string;
  icon?: string;
  components: ReadonlyArray<{ kind: string; ref: string; label: string }>;
  allowed_teams?: string;
  allowed_roles?: string;
  status?: string;
}
export interface AppPublishQuery {
  force?: "1";
}
export interface AppPermissionBody {
  subject_type: string;
  subject_id: string;
}
export interface AppPermissionQuery {
  subject_type: string;
  subject_id: string;
}
export interface AppOnboardingBody {
  title: string;
  description?: string;
  owner?: string;
  allowed_teams?: string;
  allowed_roles?: string;
  components: ReadonlyArray<{ kind: string; ref: string; label: string }>;
}
export interface AppRunsQuery {
  app_id?: string;
  limit?: number;
}
export interface AppTemplateInstantiateBody {
  key: string;
  title?: string;
  allowed_teams?: string;
  allowed_roles?: string;
}

// ── skills ──────────────────────────────────────────────────────────────────

export const skillSchema = looseObject({
  name: z.string(),
  description: optionalText,
  version: optionalText,
  owner: optionalText,
  status: optionalText,
  risk_level: optionalText,
  allowed_models: optionalText,
  allowed_tools: optionalText,
  allowed_teams: optionalText,
  daily_limit: optionalNumber,
  instructions: optionalText,
  metadata: optionalText,
  created_at: optionalText,
  updated_at: optionalText,
  updated_by: optionalText,
});
export type Skill = z.output<typeof skillSchema>;

export const skillListSchema = looseObject({ skills: z.array(skillSchema).nullish() });
export const skillWriteSchema = looseObject({ skill: skillSchema.nullish() });

export const skillPromotionListSchema = looseObject({
  promotions: looseList({
    id: optionalText,
    skill_name: optionalText,
    from_status: optionalText,
    to_status: optionalText,
    from_version: optionalText,
    to_version: optionalText,
    actor: optionalText,
    note: optionalText,
    created_at: optionalText,
  }).nullish(),
});
export type SkillPromotion = NonNullable<z.output<typeof skillPromotionListSchema>["promotions"]>[number];

export const skillRunListSchema = looseObject({
  runs: looseList({
    id: optionalText,
    skill_name: optionalText,
    skill_version: optionalText,
    actor: optionalText,
    tools_used: optionalText,
    model: optionalText,
    status: optionalText,
    cost_krw: optionalNumber,
    latency_ms: optionalNumber,
    created_at: optionalText,
  }).nullish(),
});
export type SkillRun = NonNullable<z.output<typeof skillRunListSchema>["runs"]>[number];

export const skillStatsSchema = looseObject({
  window_since: optionalText,
  stats: looseList({
    skill_name: optionalText,
    runs: optionalNumber,
    ok: optionalNumber,
    errors: optionalNumber,
    blocked: optionalNumber,
    block_rate: optionalNumber,
    total_cost_krw: optionalNumber,
    avg_latency_ms: optionalNumber,
    actors: optionalNumber,
    last_run_at: optionalText,
  }).nullish(),
});
export type SkillStat = NonNullable<z.output<typeof skillStatsSchema>["stats"]>[number];

export const skillFindingSchema = looseObject({
  severity: optionalText,
  category: optionalText,
  detail: optionalText,
});

export const skillScanResultSchema = looseObject({
  findings: z.array(skillFindingSchema).nullish(),
  max_severity: optionalText,
  high_count: optionalNumber,
  medium_count: optionalNumber,
  low_count: optionalNumber,
  clean: optionalFlag,
});
export type SkillScanResult = z.output<typeof skillScanResultSchema>;

export const skillScanListSchema = looseObject({
  scans: looseList({
    name: optionalText,
    status: optionalText,
    risk_level: optionalText,
    max_severity: optionalText,
    high_count: optionalNumber,
    medium_count: optionalNumber,
    low_count: optionalNumber,
    clean: optionalFlag,
    findings: z.array(skillFindingSchema).nullish(),
  }).nullish(),
  name: optionalText,
  scan: skillScanResultSchema.nullish(),
});
export type SkillScan = NonNullable<z.output<typeof skillScanListSchema>["scans"]>[number];

export const skillExportSchema = looseObject({
  version: optionalText,
  skills: z.array(skillSchema).nullish(),
});

export const skillImportSchema = looseObject({
  imported: z.array(z.string()).nullish(),
  imported_count: optionalNumber,
  skipped: looseList({ name: optionalText, reason: optionalText }).nullish(),
});
export type SkillImportResult = z.output<typeof skillImportSchema>;

export const skillRecommendationSchema = looseObject({
  recommendations: looseList({
    name: optionalText,
    description: optionalText,
    count: optionalNumber,
    recommended_product: optionalText,
    applied: optionalFlag,
  }).nullish(),
  applied: optionalFlag,
  count: optionalNumber,
  note: optionalText,
});
export type SkillRecommendation = NonNullable<
  z.output<typeof skillRecommendationSchema>["recommendations"]
>[number];

export const skillSeedSchema = looseObject({ seeded: z.array(z.string()).nullish() });

export const skillEvaluationSchema = looseObject({
  name: optionalText,
  status: optionalText,
  enforcement: optionalText,
  production: optionalFlag,
  allowed: optionalFlag,
  violations: z.array(z.string()).nullish(),
  would_block: optionalFlag,
});
export type SkillEvaluation = z.output<typeof skillEvaluationSchema>;

export const skillFitnessSchema = looseObject({
  skill: optionalText,
  evidence: looseList({
    id: optionalText,
    skill_name: optionalText,
    kind: optionalText,
    ref_id: optionalText,
    passed: optionalFlag,
    score: optionalNumber,
    note: optionalText,
    created_by: optionalText,
    created_at: optionalText,
  }).nullish(),
  passing_count: optionalNumber,
  required: optionalNumber,
});
export type SkillFitnessEvidence = NonNullable<z.output<typeof skillFitnessSchema>["evidence"]>[number];

/** `POST /admin/skills/fitness` answers the stored evidence row (201). */
export const skillFitnessRecordedSchema = looseObject({
  id: optionalText,
  skill_name: optionalText,
  kind: optionalText,
  ref_id: optionalText,
  passed: optionalFlag,
  score: optionalNumber,
  note: optionalText,
  created_by: optionalText,
  created_at: optionalText,
});

export const skillGraphNodeSchema = looseObject({
  id: z.string(),
  type: optionalText,
  label: optionalText,
  risk: optionalText,
});
export type SkillGraphNode = z.output<typeof skillGraphNodeSchema>;

export const skillGraphEdgeSchema = looseObject({
  from: optionalText,
  to: optionalText,
  kind: optionalText,
});
export type SkillGraphEdge = z.output<typeof skillGraphEdgeSchema>;

export const skillDependencyGraphSchema = looseObject({
  nodes: z.array(skillGraphNodeSchema).nullish(),
  edges: z.array(skillGraphEdgeSchema).nullish(),
  skills: looseList({
    name: optionalText,
    risk_level: optionalText,
    models: z.array(z.string()).nullish(),
    tools: z.array(z.string()).nullish(),
    teams: z.array(z.string()).nullish(),
    governing_policies: looseList({
      id: optionalText,
      name: optionalText,
      via: optionalText,
    }).nullish(),
  }).nullish(),
  note: optionalText,
});
export type SkillGraphSkill = NonNullable<z.output<typeof skillDependencyGraphSchema>["skills"]>[number];

export const skillStudioCandidateListSchema = looseObject({
  candidates: looseList({
    id: z.string(),
    source: optionalText,
    suggested_name: optionalText,
    title: optionalText,
    description: optionalText,
    sample: optionalText,
    rationale: optionalText,
    signal: unknownRecord.nullish(),
    suggested: looseObject({
      risk_level: optionalText,
      allowed_models: optionalText,
      allowed_tools: optionalText,
      instructions: optionalText,
    }).nullish(),
    already_skill: optionalFlag,
    score: optionalNumber,
  }).nullish(),
  count: optionalNumber,
  by_source: z.record(z.string(), numberish).nullish(),
  window_since: optionalText,
});
export type SkillCandidate = NonNullable<
  z.output<typeof skillStudioCandidateListSchema>["candidates"]
>[number];

export const skillAdoptSchema = looseObject({ skill: skillSchema.nullish() });

export const policyCheckSchema = looseObject({
  key: optionalText,
  label: optionalText,
  ok: optionalFlag,
  required: optionalFlag,
  detail: optionalText,
});
export type PolicyCheck = z.output<typeof policyCheckSchema>;

export const skillReadinessSchema = looseObject({
  name: optionalText,
  status: optionalText,
  next_status: optionalText,
  checks: z.array(policyCheckSchema).nullish(),
  production_ready: optionalFlag,
  scan: skillScanResultSchema.nullish(),
  fitness_required: optionalFlag,
  fitness_passing: optionalNumber,
  fitness_threshold: optionalNumber,
});
export type SkillReadiness = z.output<typeof skillReadinessSchema>;

export interface SkillListQuery {
  status?: string;
}
export interface SkillWriteBody {
  name: string;
  description?: string;
  version?: string;
  owner?: string;
  status?: string;
  risk_level?: string;
  allowed_models?: string;
  allowed_tools?: string;
  allowed_teams?: string;
  daily_limit?: number;
  instructions?: string;
}
export interface SkillPromoteBody {
  name: string;
  to_status: string;
  version?: string;
  note?: string;
}
export interface SkillPromotionsQuery {
  skill?: string;
  limit?: number;
}
export interface SkillRunsQuery {
  skill?: string;
  limit?: number;
}
export interface SkillStatsQuery {
  window?: string;
}
export interface SkillScanQuery {
  name?: string;
}
export interface SkillExportQuery {
  status?: string;
}
export interface SkillImportBody {
  version?: string;
  skills: ReadonlyArray<Record<string, unknown>>;
}
export interface SkillRecommendQuery {
  window?: string;
  min_count?: number;
  apply?: "1";
}
export interface SkillEvaluateBody {
  name: string;
  model?: string;
  tools?: readonly string[];
  team?: string;
}
export interface SkillFitnessQuery {
  skill: string;
}
/** Body of `POST /admin/skills/fitness` (see `handleSkillFitness`). */
export interface SkillFitnessBody {
  skill: string;
  kind: "multimodel" | "golden" | "testcase";
  ref_id: string;
  passed: boolean;
  score: number;
  note: string;
}
export interface SkillGraphQuery {
  skill?: string;
}
export interface SkillStudioCandidateQuery {
  window?: string;
  min_count?: number;
  limit?: number;
}
export interface SkillAdoptBody {
  name: string;
  description?: string;
  instructions?: string;
  risk_level?: string;
  allowed_models?: string;
  allowed_tools?: string;
  allowed_teams?: string;
  daily_limit?: number;
  source?: string;
}
export interface SkillReadinessQuery {
  name: string;
}
