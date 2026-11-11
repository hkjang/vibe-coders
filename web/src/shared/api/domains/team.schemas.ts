import { z } from "zod";
import { numberish } from "@/shared/api/loose";

// Keep missing measurements distinct from zero. Only declared display fields
// survive parsing; request bodies and unrelated server fields are discarded.
const text = z
  .string()
  .nullish()
  .transform((value) => value ?? "");
const metric = numberish
  .refine(Number.isFinite)
  .nullish()
  .transform((value) => value ?? undefined);
const flag = z
  .boolean()
  .nullish()
  .transform((value) => value ?? undefined);
const strings = z
  .array(z.string())
  .nullish()
  .transform((value) => value ?? []);
const rows = <S extends z.ZodType>(schema: S) =>
  z
    .array(schema)
    .nullish()
    .transform((value) => value ?? []);
const envelope = {
  team_id: z.string().min(1),
  since: text,
  partial_failures: strings,
};
const totals = z.object({
  requests: metric,
  tokens: metric,
  cost_krw: metric,
  errors: metric,
  avg_latency_ms: metric,
  success_rate: metric,
});
const model = z.object({ model: text, requests: metric, cost_krw: metric });
const skill = z.object({
  skill_name: text,
  runs: metric,
  ok: metric,
  errors: metric,
  success_rate: metric,
  total_cost_krw: metric,
  avg_latency_ms: metric,
});

export const teamDashboardSchema = z.object({
  ...envelope,
  dashboard: z
    .object({
      team_keys: strings,
      totals: totals.nullish(),
      top_users: rows(z.object({ user_id: text, requests: metric, cost_krw: metric, errors: metric })),
      models: rows(model),
      recent_failures: rows(
        z.object({ id: text, model: text, status_code: metric, error: text, created_at: text }),
      ),
    })
    .nullish(),
});
export const teamReportSchema = z.object({
  id: z.string().min(1),
  name: text,
  question: text,
  sql: text,
  schema_name: text,
  kind: text,
  created_by: text,
  created_at: text,
  schedule_interval: text,
  schedule_enabled: flag,
  deliver_mattermost: flag,
  last_run_at: text,
  team: text,
  visibility: text,
  approval_status: text,
  approved_by: text,
  approved_at: text,
  revision: text,
});
export const teamReportsSchema = z.object({ ...envelope, reports: rows(teamReportSchema) });
export type TeamReportRow = z.output<typeof teamReportSchema>;
export const teamReportDecisionSchema = z.object({
  report_id: z.string().min(1),
  approval_status: z.enum(["approved", "rejected"]),
});
export const teamSavingsChallengeSchema = z.object({
  ...envelope,
  month_to_date_krw: metric,
  projected_month_end_krw: metric,
  last_month_krw: metric,
  projected_savings_krw: metric,
  on_track: flag,
  days_elapsed: metric,
  days_in_month: metric,
});
export const teamOnboardingSchema = z.object({
  ...envelope,
  note: text,
  recommended_models: rows(model),
  recommended_skills: rows(skill),
  recommended_mcp: rows(
    z.object({
      server_label: text,
      tool_name: text,
      ref: text,
      calls: metric,
      errors: metric,
      success_rate: metric,
      avg_latency_ms: metric,
    }),
  ),
});
export const teamRiskSchema = z.object({
  ...envelope,
  blocked: metric,
  warned: metric,
  blocked_prior_window: metric,
  blocked_trend: metric,
  secrets_total: metric,
  pending_approvals: metric,
  recent_violations: rows(
    z.object({
      decision: text,
      reason: text,
      rule: text,
      endpoint: text,
      risk_score: metric,
      created_at: text,
    }),
  ),
});
export const teamPopularSkillsSchema = z.object({ ...envelope, skills: rows(skill) });
export const teamTemplateCandidatesSchema = z.object({
  ...envelope,
  candidates: rows(
    z.object({
      fingerprint: text,
      task_type: text,
      requests: metric,
      avg_cost_krw: metric,
      success_rate: metric,
      already_product: flag,
    }),
  ),
});
export const teamPortalSchema = z.object({
  ...envelope,
  note: text,
  usage: totals.nullish(),
  budgets: rows(
    z.object({
      monthly_krw: metric,
      spent_krw: metric,
      burn_ratio: metric,
      projected_krw: metric,
      projected_ratio: metric,
      on_track: flag,
      exhaustion_date: text,
      note: text,
    }),
  ),
  api_keys: rows(
    z.object({
      id: z.string().min(1),
      name: text,
      owner: text,
      user_id: text,
      role: text,
      status: text,
      expires_at: text,
      budget_limit_krw: metric,
    }),
  ),
  api_key_count: metric,
  members: strings,
  member_count: metric,
  accessible_skills: rows(z.object({ name: text, description: text, version: text, risk_level: text })),
  skill_count: metric,
  pending_skill_requests: rows(
    z.object({ id: z.string().min(1), skill_name: text, user_id: text, reason: text, created_at: text }),
  ),
});
