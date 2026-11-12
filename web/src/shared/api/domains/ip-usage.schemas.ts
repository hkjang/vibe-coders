import { z } from "zod";

// Deliberate allowlist: raw request prompts/errors/headers must never enter the
// IP explorer's query cache. Missing metrics remain unknown, never default zero.
const label = z
  .string()
  .max(8192)
  .nullish()
  .transform((value) => value ?? "");
const metric = z
  .number()
  .finite()
  .nonnegative()
  .nullish()
  .transform((value) => value ?? undefined);
const count = z
  .number()
  .int()
  .nonnegative()
  .nullish()
  .transform((value) => value ?? undefined);
const usage = { requests: count, tokens: count, cost_krw: metric };
export const ipSummarySchema = z.object({
  ip: z.string().min(1).max(128),
  ...usage,
  average_latency_ms: metric,
  last_seen: label,
  distinct_keys: count,
});
export const adminIpsSchema = z.object({
  // Historical raw-view responses can include malformed address groups. The
  // adapter discards these identities, with an explicit excluded-row count.
  ips: z.array(ipSummarySchema.extend({ ip: z.string().max(8192) })).max(200),
});
export type IpSummary = z.output<typeof ipSummarySchema>;
const group = z.object({ key: label, ...usage, average_latency_ms: metric });
const day = z.object({ date: label, ...usage });
const language = z.object({ language: label, requests: count, average_confidence: metric });
const recent = z.object({
  id: z.string().min(1).max(512),
  model: label,
  status_code: count,
  latency_ms: metric,
  total_tokens: count,
  estimated_cost: metric,
  created_at: label,
});
export const adminIpDetailSchema = z.object({
  stats: ipSummarySchema,
  daily: z.array(day).max(60).optional(),
  by_model: z.array(group).max(50).optional(),
  by_key: z.array(group).max(50).optional(),
  by_language: z.array(language).max(50).optional(),
  recent: z.array(recent).max(200).optional(),
});
export type IpDetail = z.output<typeof adminIpDetailSchema>;
export type IpGroup = z.output<typeof group>;
export type IpDay = z.output<typeof day>;
export type IpLanguage = z.output<typeof language>;
export type IpRecent = z.output<typeof recent>;
