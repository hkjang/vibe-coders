import { z } from "zod";
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(2048).nullable();
export const traceRelatedRunSchema = z
  .object({
    row_key: z.string().regex(/^run_[A-Za-z0-9_-]{43}$/u),
    id: text,
    resource_id: text,
    resource_name: text,
    status: z.enum([
      "ok",
      "error",
      "planned",
      "pending_approval",
      "condition_failed",
      "passed",
      "stopped",
      "skipped",
      "unknown",
    ]),
    created_at: z.iso.datetime({ offset: true }).nullable(),
    latency_ms: count.nullable(),
    cost_krw: z.number().min(0).max(1e15).nullable(),
    receipt_available: z.boolean(),
  })
  .strict();
export const traceRelatedRunsQuerySchema = z
  .object({
    kind: z.enum(["workflow", "app"]),
    limit: z.union([z.literal(25), z.literal(50), z.literal(100)]),
    offset: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export const traceRelatedRunsSchema = traceRelatedRunsQuerySchema
  .extend({
    related_runs_version: z.literal(1),
    items: z.array(traceRelatedRunSchema).max(100),
    total: count,
  })
  .strict()
  .superRefine((page, context) => {
    if (
      page.items.length > page.limit ||
      page.items.length > Math.max(0, page.total - page.offset) ||
      new Set(page.items.map((row) => row.row_key)).size !== page.items.length
    )
      context.addIssue({ code: "custom", message: "Invalid related run page" });
  });
export type TraceRelatedRun = z.output<typeof traceRelatedRunSchema>;
export type TraceRelatedRunsQuery = z.input<typeof traceRelatedRunsQuerySchema>;
