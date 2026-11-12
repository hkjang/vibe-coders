import { z } from "zod";

// Personal metadata is allowlisted before caching. Missing measurements remain
// unknown; several existing endpoints use -1 for an unobserved measurement.
const text = z
  .string()
  .nullish()
  .transform((value) => value ?? "");
const number = z
  .number()
  .finite()
  .nullish()
  .transform((value) => value ?? undefined);
const metric = z
  .number()
  .finite()
  .nullish()
  .transform((value) => (value == null || value < 0 ? undefined : value));
const ratio = z
  .number()
  .finite()
  .min(-1)
  .max(1)
  .nullish()
  .transform((value) => (value == null || value < 0 ? undefined : value));
const percent = z
  .number()
  .finite()
  .min(-1)
  .max(100)
  .nullish()
  .transform((value) => (value == null || value < 0 ? undefined : value));
const flag = z
  .boolean()
  .nullish()
  .transform((value) => value ?? undefined);
const id = z.string().min(1).max(512);
const strings = z
  .array(z.string())
  .nullish()
  .transform((value) => value ?? []);
const partial = { partial_failures: strings };
function rows<S extends z.ZodRawShape>(shape: S) {
  return z
    .array(z.object(shape))
    .nullish()
    .transform((value) => value ?? []);
}
const model = { model: text, requests: metric, avg_cost_krw: metric, success_rate: ratio };
const totals = z.object({ requests: metric, tokens: metric, cost_krw: metric, errors: metric });
export const meDashboardSchema = z.object({
  user_id: id,
  ...partial,
  today: totals.nullish(),
  month: totals.nullish(),
  profile: z
    .object({
      success_rate: ratio,
      avg_latency_ms: metric,
      cache_rate: ratio,
      text2sql_usage_rate: ratio,
      mcp_usage_rate: ratio,
      risk_score: metric,
      summary: text,
      since: text,
      top_task_types: rows({ key: text, requests: metric }),
      top_models: rows({ model: text, key: text, requests: metric }),
      top_languages: rows({ language: text, key: text, requests: metric }),
      top_mcp_tools: rows({ tool: text, key: text, requests: metric }),
    })
    .nullish(),
  frequent_models: rows(model),
  recent_failures: rows({
    id,
    model: text,
    status_code: metric,
    error: text,
    task_type: text,
    created_at: text,
  }),
  potential_savings_krw: metric,
  potential_savings_model: text,
  recommended_templates: rows({ id, name: text, category: text, description: text }),
  recent_prompt_products: rows({ id, name: text, description: text }),
  key_alerts: rows({
    id,
    name: text,
    user_id: text,
    team: text,
    expires_at: text,
    last_used_at: text,
    days_idle: metric,
    flags: strings,
    severity: text,
  }),
  recent_blocks: rows({ rule: text, reason: text, model: text, endpoint: text, created_at: text }),
  my_saved_reports: rows({
    id,
    name: text,
    schema_name: text,
    kind: text,
    visibility: text,
    approval_status: text,
    created_at: text,
  }),
});
export type MeDashboard = z.output<typeof meDashboardSchema>;
export const meActionsSchema = z.object({
  user_id: id,
  ...partial,
  count: metric,
  actions: rows({ type: id, severity: text, message: text, button_label: text, button_href: text }),
});
export type MeAction = z.output<typeof meActionsSchema>["actions"][number];
export const meSnoozeSchema = z.object({ type: id, snoozed_until: z.string().min(1) });
export const meReportSchema = z.object({
  user_id: id,
  ...partial,
  window: z.enum(["weekly", "monthly"]),
  since: text,
  requests: metric,
  tokens: metric,
  cost_krw: metric,
  errors: metric,
  success_rate: ratio,
  prior_cost_krw: metric,
  prior_requests: metric,
  cost_delta_ratio: number,
  avg_latency_ms: metric,
  cache_rate: ratio,
  risk_score: metric,
  top_models: rows(model),
  top_task_types: rows({ key: text, requests: metric }),
  potential_savings_krw: metric,
  potential_savings_model: text,
  recommendation_count: metric,
});
export const meNotificationsSchema = z.object({
  user_id: id,
  ...partial,
  count: metric,
  critical_count: metric,
  notifications: rows({
    category: text,
    level: text,
    title: text,
    detail: text,
    created_at: text,
    href: text,
  }),
});
export const meRecommendedModelsSchema = z.object({
  ...partial,
  note: text,
  tagged_model_count: metric,
  task_recommendations: rows({ task_type: text, requests: metric, recommend: strings, avoid: strings }),
  your_models: rows({
    model: text,
    requests: metric,
    tags: z.object({ good_for: text, avoid_for: text, risk_note: text }).nullish(),
  }),
  team_winners: rows({ model: text, wins: metric, avg_score: metric, appearances: metric }),
});
export const meRequestsSchema = z.object({
  requests: rows({
    id,
    model: text,
    provider: text,
    endpoint: text,
    status_code: metric,
    cost_krw: metric,
    total_tokens: metric,
    cached: flag,
    created_at: text,
  }),
});
export type MeRequest = z.output<typeof meRequestsSchema>["requests"][number];
export const meReceiptSchema = z.object({
  request_id: id,
  ...partial,
  created_at: text,
  endpoint: text,
  model: text,
  provider: text,
  status_code: metric,
  finish_reason: text,
  latency_ms: metric,
  tokens: z.object({ prompt: metric, completion: metric, total: metric, cached: metric }).nullish(),
  cache_hit: flag,
  cost_krw: metric,
  blocked: flag,
  policy: rows({ decision: text, rule: text, reason: text }),
  mcp_used: flag,
  mcp_tools: rows({ server: text, tool: text, error: flag }),
  skill_used: flag,
  skills: strings,
  note: text,
  routing: z
    .object({
      requested_model: text,
      selected_model: text,
      selected_provider: text,
      reason: text,
      fallback_path: strings,
      risk_tier: text,
      complexity_tier: text,
    })
    .nullish(),
});
export type MeReceipt = z.output<typeof meReceiptSchema>;
const skill = {
  name: id,
  description: text,
  risk_level: text,
  runs_30d: metric,
  // /me/skills returns percent (0..100), whereas dashboard/report return ratios.
  success_rate: percent,
  users_30d: metric,
  satisfaction: z
    .number()
    .finite()
    .min(-1)
    .max(5)
    .nullish()
    .transform((value) => (value == null || value < 0 ? undefined : value)),
  feedback_count: metric,
};
export const meSkillsSchema = z.object({
  team: text,
  ...partial,
  available: rows(skill),
  requestable: rows(skill),
});
export type MeSkill = z.output<typeof meSkillsSchema>["available"][number];
export const meSkillActionSchema = z.object({ status: z.enum(["requested", "recorded"]), skill: id });
export const meRecommendationsSchema = z.object({
  user_id: id,
  recommendations: rows({
    id,
    user_id: id,
    kind: text,
    ref: text,
    title: text,
    detail: text,
    est_savings_krw: metric,
    created_at: text,
  }),
});
export type MeRecommendation = z.output<typeof meRecommendationsSchema>["recommendations"][number];
export const meRecommendationFeedbackSchema = z.object({
  status: z.literal("recorded"),
  kind: text,
  action: z.enum(["adopted", "dismissed", "later"]),
});
