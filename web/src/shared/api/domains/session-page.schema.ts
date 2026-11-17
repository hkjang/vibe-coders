import { z } from "zod";
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const cost = z.number().min(0).max(1e15);
export const sessionExplorerQuerySchema = z
  .object({
    days: z.number().int().min(1).max(365),
    q: z.string().max(256).optional(),
    limit: z.union([z.literal(25), z.literal(50), z.literal(100)]),
    offset: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export const sessionExplorerRowSchema = z
  .object({
    row_key: z.string().regex(/^session_[A-Za-z0-9_-]{43}$/u),
    session_id: z.string().max(1024).nullable(),
    requests: count,
    first_seen: z.iso.datetime({ offset: true }),
    last_seen: z.iso.datetime({ offset: true }),
    models: count,
    api_keys: count,
    errors: count,
    total_tokens: count,
    cost_krw: cost,
    last_message: z.string().refine((value) => [...value].length <= 160),
  })
  .strict();
export const sessionExplorerPageSchema = z
  .object({
    session_page_version: z.literal(1),
    days: z.number().int().min(1).max(365),
    limit: z.union([z.literal(25), z.literal(50), z.literal(100)]),
    offset: z.number().int().min(0).max(1_000_000),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    sessions: z.array(sessionExplorerRowSchema).max(100),
    summary: z
      .object({ sessions: count, requests: count, errors: count, total_tokens: count, cost_krw: cost })
      .strict(),
  })
  .strict()
  .superRefine((page, ctx) => {
    if (
      page.sessions.length > page.limit ||
      page.sessions.length > Math.max(0, page.summary.sessions - page.offset) ||
      page.offset % page.limit !== 0 ||
      new Set(page.sessions.map((row) => row.row_key)).size !== page.sessions.length ||
      Date.parse(page.from) >= Date.parse(page.to) ||
      page.summary.errors > page.summary.requests
    )
      ctx.addIssue({ code: "custom", message: "Invalid session page" });
  });
export type SessionExplorerQuery = z.input<typeof sessionExplorerQuerySchema>;
export type SessionExplorerRow = z.output<typeof sessionExplorerRowSchema>;
