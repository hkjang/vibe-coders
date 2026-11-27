import { z } from "zod";

import { looseObject, orDefault } from "@/shared/api/loose";

// Shapes shared by the work-usage analytics and the classification console
// (docs/WORK_INTELLIGENCE_DESIGN.md §7). The server documents these responses as
// generic objects, so these schemas are the contract the console reads them by.

const text = orDefault(z.string(), "");
const count = orDefault(z.number(), 0);

export const workMetricIds = ["sessions", "requests", "users", "tokens", "cost", "mcp_calls"] as const;
export type WorkMetricId = (typeof workMetricIds)[number];

export const workActionIds = [
  "read",
  "analyze",
  "create",
  "modify",
  "delete",
  "verify",
  "plan",
  "automate",
  "unknown",
] as const;
export type WorkActionId = (typeof workActionIds)[number];

export const workStatuses = ["classified", "review", "unclassified", "failed"] as const;
export const workMethods = ["rule", "llm", "cache", "manual"] as const;

export const categoryRefSchema = looseObject({
  id: z.string(),
  name: text,
  level: orDefault(z.number(), 1),
  parent_id: text,
  top_id: text,
  enabled: orDefault(z.boolean(), true),
});
export type CategoryRef = z.output<typeof categoryRefSchema>;

/**
 * A measure the server may withhold to protect a small group: `null` means
 * withheld and stays `null` (never a misleading 0); a missing value, from a server
 * that predates the protection, still reads as 0.
 */
export const withheldNumber = z
  .number()
  .nullable()
  .optional()
  .transform((value) => (value === undefined ? 0 : value));

/**
 * One group's measures. For a caller who may not see raw prompts, a group whose
 * unique users are fewer than `scope.min_group_size` (or one whose value could be
 * recovered from its neighbours by subtraction) has all six measures `null` and
 * `suppressed: true`. `users` alone may also be `null` when it is unknown.
 */
export const metricsSchema = looseObject({
  sessions: withheldNumber,
  requests: withheldNumber,
  users: orDefault(z.number().nullable(), null),
  tokens: withheldNumber,
  cost_krw: withheldNumber,
  mcp_calls: withheldNumber,
  suppressed: orDefault(z.boolean(), false),
});
export type WorkMetrics = z.output<typeof metricsSchema>;

export const scopeSchema = looseObject({
  from: text,
  to: text,
  prev_from: text,
  prev_to: text,
  team_scoped: orDefault(z.boolean(), false),
  min_group_size: orDefault(z.number(), 3),
  data_through: text,
  backlog: count,
  classify_enabled: orDefault(z.boolean(), true),
  policy_version: count,
  /**
   * The caller may not see raw prompts, so small groups are withheld from them
   * (and the overview's classification-quality distributions are always empty).
   */
  small_groups_withheld: orDefault(z.boolean(), false),
});
export type WorkScope = z.output<typeof scopeSchema>;

/** One classified request: the leaf of every drill-down and the review queue row. */
export const workRequestSchema = looseObject({
  request_id: z.string(),
  created_at: text,
  session_id: text,
  team: text,
  user: text,
  client: text,
  model: text,
  category: categoryRefSchema,
  action_type: text,
  confidence: count,
  method: text,
  status: text,
  work_title: text,
  tags: orDefault(z.array(z.string()), []),
  technologies: orDefault(z.array(z.string()), []),
  tokens: count,
  cost_krw: count,
  latency_ms: count,
  is_error: orDefault(z.boolean(), false),
  policy_version: count,
});
export type WorkRequest = z.output<typeof workRequestSchema>;

/** The largest list offset the server answers; list counts stop at the same number. */
export const workMaxOffset = 100_000;

/** The filters every analytics read accepts; all optional. */
export const workQuerySchema = z
  .object({
    from: z.string().max(10).optional(),
    to: z.string().max(10).optional(),
    compare: z.enum(["prev", "none"]).optional(),
    team: z.string().max(128).optional(),
    user: z.string().max(128).optional(),
    category: z.string().max(128).optional(),
    action: z.string().max(32).optional(),
    model: z.string().max(160).optional(),
    provider: z.string().max(128).optional(),
    client: z.string().max(128).optional(),
    tool: z.string().max(160).optional(),
    status: z.string().max(32).optional(),
    metric: z.enum(workMetricIds).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).max(workMaxOffset).optional(),
  })
  .strict();
export type WorkQuery = z.input<typeof workQuerySchema>;
